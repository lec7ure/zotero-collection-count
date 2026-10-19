/* Zotero Collection Count
 * ---------------------------------------------------------------------------
 * Shows the number of items of each collection (folder) next to its name in
 * the left collections tree, like EndNote does.
 *
 * Nothing else is modified: the count is a purely cosmetic span appended to the
 * row label; no data, no DB changes, no extra columns.
 *
 * Compatible with Zotero 7 / 8 / 10 (patches CollectionTree's React row
 * renderer and the underlying windowed list).
 * ---------------------------------------------------------------------------
 */

var chromeHandle;

var COUNT_CLASS = "collection-count-number";

var _s = {
	initialized: false,
	win: null,
	view: null,                  // win.ZoteroPane.collectionsView (React component)
	originalRenderItem: null,    // original collectionsView.renderItem
	patchedJsWindow: null,        // windowed-list instance we patched
	cache: new Map(),            // collectionKey -> {direct, total}
	pending: new Map(),           // collectionKey -> Promise
	debounce: null,
	readyTimer: null,
	ensureTimer: null
};

function log(msg) {
	try { Zotero.debug("[collection-count] " + msg); } catch (e) {}
}

/* ===========================================================================
 * Counting
 * =========================================================================*/

function clearCounts() {
	_s.cache.clear();
	_s.pending.clear();
}

// Number of items directly contained in the collection (trash excluded)
function countDirectItems(collection) {
	try {
		if (collection._loaded && collection._loaded.childItems) {
			return Promise.resolve(collection.getChildItems(false, false).length);
		}
	} catch (e) {}
	// Load child data if it isn't loaded yet, then retry
	return collection.loadDataType("childItems")
		.then(() => collection.getChildItems(false, false).length)
		.catch(() => fallbackSearch(collection).then(ids => ids.length)
			.catch(() => 0));
}

// Fallback (and cross-check) counting via the search engine
function fallbackSearch(collection, recursive) {
	var search = new Zotero.Search();
	search.addCondition("collectionID", "is", collection.key);
	if (recursive) {
		search.addCondition("recursive", "true");
	}
	return search.search();
}

function getChildCollections(collection) {
	try {
		return Promise.resolve(collection.getChildCollections());
	} catch (e) {
		return collection.loadDataType("childCollections")
			.then(() => collection.getChildCollections())
			.catch(() => []);
	}
}

// { direct, total } with total = direct + all sub-collections, recursively
function getCounts(collection) {
	var key = collection.key;
	var cached = _s.cache.get(key);
	if (cached) {
		return Promise.resolve(cached);
	}
	var pending = _s.pending.get(key);
	if (pending) {
		return pending;
	}
	var promise = countDirectItems(collection).then(function (direct) {
		var total = direct;
		return getChildCollections(collection).then(function (children) {
			var chain = Promise.resolve();
			children.forEach(function (child) {
				chain = chain.then(function () {
					return getCounts(child).then(function (c) {
						total += c.total;
					});
				});
			});
			return chain.then(function () {
				var result = { direct: direct, total: total };
				_s.cache.set(key, result);
				_s.pending.delete(key);
				return result;
			});
		});
	});
	_s.pending.set(key, promise);
	return promise;
}

/* ===========================================================================
 * DOM decoration
 * =========================================================================*/

function setNumberText(node, counts) {
	var doc = node.ownerDocument;
	node.textContent = "";
	var direct = counts ? counts.direct : 0;
	var total = counts ? counts.total : 0;
	if (counts && direct > 0 && direct !== total) {
		// "12 15" -> 12 items directly here (dimmed), 15 including sub-folders.
		// direct === 0 (a pure parent folder) shows only the total, no "0".
		var dim = doc.createElement("span");
		dim.textContent = String(direct);
		dim.style.opacity = "0.55";
		dim.style.marginRight = "4px";
		node.appendChild(dim);
		node.appendChild(doc.createTextNode(String(total)));
		node.title = "本分类 " + direct + " 条，含子分类共 " + total + " 条";
	} else {
		node.textContent = String(total);
		node.title = total + " 条";
	}
}

function decorateRow(div, collection) {
	if (!div || typeof div.querySelector !== "function") {
		return;
	}
	var primary = div.querySelector(".cell.primary") || div.querySelector(".primary");
	if (!primary) {
		return;
	}
	var node = primary.querySelector("." + COUNT_CLASS);
	if (!node) {
		node = div.ownerDocument.createElement("span");
		node.className = COUNT_CLASS;
		node.dataset.collectionKey = collection.key;
		node.style.marginLeft = "auto";
		node.style.opacity = "0.85";
		node.style.paddingLeft = "8px";
		node.style.flexShrink = "0";
		primary.appendChild(node);
	}
	var cached = _s.cache.get(collection.key);
	if (cached) {
		setNumberText(node, cached);
	} else {
		node.textContent = "";
	}
	getCounts(collection).then(function (counts) {
		// The row may have been recycled/re-rendered while we were counting
		if (!node.isConnected || node.dataset.collectionKey !== collection.key) {
			return;
		}
		setNumberText(node, counts);
	}).catch(function (e) {
		log("count error: " + e);
	});
}

function isCollectionRow(row) {
	if (!row) {
		return false;
	}
	if (typeof row.isCollection === "function") {
		try {
			return row.isCollection() && !!row.ref;
		} catch (e) {}
	}
	return !!(row.ref && row.ref._ObjectType === "Collection");
}

/* ===========================================================================
 * Patching
 * =========================================================================*/

function ensurePatched() {
	var view = _s.view;
	if (!view) {
		return;
	}
	// 1. Patch the view's row renderer (used on every React re-render of the
	//    collection tree, e.g. after add/remove/filter/selection changes).
	if (!_s.originalRenderItem && typeof view.renderItem === "function") {
		var original = view.renderItem;
		try {
			view.renderItem = function (index, selection, oldDiv, columns) {
				var div = original.call(view, index, selection, oldDiv, columns);
				try {
					var row = view.getRow(index);
					if (isCollectionRow(row)) {
						decorateRow(div, row.ref);
					}
				} catch (e) {}
				return div;
			};
			_s.originalRenderItem = original;
			view.__collectionCountPatched = true;
			log("patched collectionsView.renderItem");
		} catch (e) {
			log("failed to patch renderItem: " + e);
		}
	}
	// 2. Patch the windowed list's renderer so counts also show up on rows
	//    rendered before the view patch takes effect (initial paint).
	try {
		var jsWindow = view.tree && view.tree._jsWindow;
		if (jsWindow && _s.patchedJsWindow !== jsWindow && typeof jsWindow.renderItem === "function") {
			var origJs = jsWindow.renderItem;
			jsWindow.renderItem = function (index, oldElem) {
				var elem = origJs.call(jsWindow, index, oldElem);
				try {
					var row = view.getRow(index);
					if (isCollectionRow(row)) {
						decorateRow(elem, row.ref);
					}
				} catch (e) {}
				return elem;
			};
			_s.patchedJsWindow = jsWindow;
			log("patched windowed-list renderItem");
		}
	} catch (e) {
		log("failed to patch windowed-list: " + e);
	}
}

function refreshRows() {
	try {
		if (_s.view && _s.view.tree) {
			_s.view.tree.invalidate();
		}
	} catch (e) {}
}

/* ===========================================================================
 * Notifier
 * =========================================================================*/

var _membershipEvents = {
	add: true,
	remove: true,
	delete: true,
	trash: true,
	untrash: true,
	refresh: true
};

var observer = {
	notify: function (event, type, ids, extraData) {
		// Only events that can change what appears inside a collection matter
		var interesting = (type === "item" && _membershipEvents[event])
			|| type === "collection" || type === "collection-item" || type === "trash";
		if (!interesting) {
			return;
		}
		if (_s.debounce) {
			clearTimeout(_s.debounce);
		}
		_s.debounce = setTimeout(function () {
			_s.debounce = null;
			clearCounts();
			ensurePatched();
			refreshRows();
		}, 400);
	}
};

/* ===========================================================================
 * Lifecycle
 * =========================================================================*/

function getMainWindow() {
	try {
		var win = Zotero.getMainWindow();
		if (win) {
			return win;
		}
	} catch (e) {}
	try {
		var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
		var windows = Services.wm.getEnumerator("navigator:browser");
		while (windows.hasMoreElements()) {
			var w = windows.getNext();
			if (w.Zotero) {
				return w;
			}
		}
	} catch (e) {}
	return null;
}

function viewReady() {
	try {
		if (!_s.win) {
			_s.win = getMainWindow();
		}
		return !!(_s.win && _s.win.ZoteroPane && _s.win.ZoteroPane.collectionsView
			&& _s.win.ZoteroPane.collectionsView.tree);
	} catch (e) {
		return false;
	}
}

function watchForView() {
	if (viewReady()) {
		_s.view = _s.win.ZoteroPane.collectionsView;
		clearCounts();
		ensurePatched();
		refreshRows();
		if (!_s.ensureTimer) {
			// Cheap idempotent re-check in case the tree gets rebuilt
			_s.ensureTimer = setInterval(function () {
				try {
					if (!_s.win) {
						return;
					}
					var currentView = _s.win.ZoteroPane && _s.win.ZoteroPane.collectionsView;
					if (currentView && currentView !== _s.view) {
						// A new view instance was created: restore the old one and re-patch
						if (_s.view && _s.view.__collectionCountPatched && _s.originalRenderItem) {
							try {
								_s.view.renderItem = _s.originalRenderItem;
								_s.view.__collectionCountPatched = false;
							} catch (e) {}
						}
						_s.view = currentView;
						_s.originalRenderItem = null;
						_s.patchedJsWindow = null;
					}
					ensurePatched();
				} catch (e) {}
			}, 2000);
		}
		return;
	}
	if (_s.readyTimer) {
		clearTimeout(_s.readyTimer);
	}
	_s.readyTimer = setTimeout(watchForView, 250);
}

function init() {
	if (_s.initialized) {
		return;
	}
	_s.initialized = true;
	watchForView();
	try {
		Zotero.Notifier.registerObserver(observer, ["collection", "collection-item", "item", "trash"], "collection-count");
	} catch (e) {
		log("failed to register observer: " + e);
	}
	log("initialized");
}

function teardown() {
	if (_s.ensureTimer) { clearInterval(_s.ensureTimer); _s.ensureTimer = null; }
	if (_s.readyTimer) { clearTimeout(_s.readyTimer); _s.readyTimer = null; }
	if (_s.debounce) { clearTimeout(_s.debounce); _s.debounce = null; }
	try { Zotero.Notifier.unregisterObserver("collection-count"); } catch (e) {}
	var view = _s.view;
	if (view) {
		try {
			if (view.__collectionCountPatched && _s.originalRenderItem) {
				view.renderItem = _s.originalRenderItem;
				view.__collectionCountPatched = false;
			}
		} catch (e) {}
		try {
			if (view.tree) {
				view.tree.invalidate();
			}
		} catch (e) {}
	}
	_s.view = null;
	_s.originalRenderItem = null;
	_s.patchedJsWindow = null;
	clearCounts();
	log("shutdown");
}

/* ===========================================================================
 * Bootstrap entry points
 * =========================================================================*/

function install(data, reason) {
}

async function startup(data, reason) {
	try {
		await Zotero.initializationPromise;
	} catch (e) {}
	init();
}

async function onMainWindowLoad(opts, reason) {
	try {
		_s.win = opts && opts.window ? opts.window : getMainWindow();
	} catch (e) {}
	if (_s.initialized) {
		watchForView();
	} else {
		init();
	}
}

async function onMainWindowUnload(opts, reason) {
}

function shutdown(data, reason) {
	if (typeof APP_SHUTDOWN !== "undefined" && reason === APP_SHUTDOWN) {
		return;
	}
	teardown();
}

function uninstall(data, reason) {
}
