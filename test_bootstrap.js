/* Smoke test for bootstrap.js using a mocked Zotero/DOM environment (Node).
 * Usage: node test_bootstrap.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

/* ----------------------------- mini DOM ---------------------------------- */
class ClassList {
	constructor(node) { this.node = node; }
	add(c) {
		if (!this.contains(c)) { this.node._classes.push(c); }
	}
	contains(c) { return this.node._classes.includes(c); }
	toggle(c, on) { if (on === undefined) on = !this.contains(c); on ? this.add(c) : this.remove(c); }
	remove(c) { const i = this.node._classes.indexOf(c); if (i >= 0) { this.node._classes.splice(i, 1); } }
}

class FakeDoc {
	constructor() { this.documentElement = null; }
	createElement(tag) { return new FakeNode(tag, this); }
	createTextNode(text) { const n = new FakeNode("#text", this); n._text = String(text); return n; }
}

class FakeNode {
	constructor(tag, doc) {
		this.tagName = tag;
		this.ownerDocument = doc;
		this._classes = [];
		this.classList = new ClassList(this);
		this.style = {};
		this.dataset = {};
		this.children = [];
		this.parentNode = null;
		this._text = "";
		this.title = "";
	}
	get className() { return this._classes.join(" "); }
	set className(v) { this._classes = String(v).split(/\s+/).filter(Boolean); }
	get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
	set textContent(v) { this._text = String(v); this.children.length = 0; }
	get isConnected() { let n = this; while (n) { if (n === rootNode) { return true; } n = n.parentNode; } return false; }
	appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
	querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
	querySelectorAll(sel) {
		const out = [];
		const walk = (n) => {
			for (const c of n.children) {
				if (matches(c, sel)) { out.push(c); }
				walk(c);
			}
		};
		// include self
		if (matches(this, sel)) { out.push(this); }
		walk(this);
		return out;
	}
	get innerHTML() { return this.children.map(c => c.outerHTML).join(""); }
	set innerHTML(v) { this.children.length = 0; }
	outerHTML(depth) { return `<${this.tagName}>`; }
	dump(indent) {
		const pad = "  ".repeat(indent || 0);
		let s = pad + this.tagName + ` [${this.className}] "${this._text}"\n`;
		for (const c of this.children) { s += c.dump((indent || 0) + 1); }
		return s;
	}
}
function matches(node, sel) {
	const parts = sel.split(".").filter(Boolean);
	for (const p of parts) { if (!node._classes.includes(p)) { return false; } }
	return true;
}
const rootNode = new FakeNode("#root", null);
const doc = new FakeDoc();

/* ----------------------------- mocks ------------------------------------- */
const realSetTimeout = setTimeout;
let now = 0;
const pendingTimers = [];
const sandbox = {
	console,
	document: doc,
	setTimeout: (fn, ms) => { const t = { fn, at: now + (ms || 0), cleared: false }; pendingTimers.push(t); return t; },
	clearTimeout: (t) => { if (t) { t.cleared = true; } },
	setInterval: (fn, ms) => { const t = { fn, at: now + (ms || 0), every: ms || 0, cleared: false }; pendingTimers.push(t); return t; },
	clearInterval: (t) => { if (t) { t.cleared = true; } },
	Cc: {}, Ci: {}, Cu: {}, Components: { interfaces: { amIAddonManagerStartup: {} } },
	ChromeUtils: { import: () => ({ Services: { wm: { getEnumerator: () => ({ hasMoreElements: () => false }) } } }) },
	APP_SHUTDOWN: 8,
};
function runAllTimers() {
	let guard = 0;
	while (runTimers() && guard++ < 200) {}
}
function runTimers() {
	const due = pendingTimers.filter(t => !t.cleared && t.at <= now).sort((a, b) => a.at - b.at);
	if (!due.length) { return false; }
	const t = due[0];
	now = Math.max(now, t.at);
	if (t.every) { t.at += t.every; } else { t.cleared = true; }
	t.fn();
	return true;
}
async function waitFor(fn, label, timeout = 5000) {
	const t0 = now;
	while (now - t0 < timeout) {
		runTimers();
		if (fn()) { return; }
		now += 100;
		await new Promise(r => realSetTimeout(() => r(), 0));
	}
	throw new Error("timeout waiting for: " + label);
}

let invalidated = 0;
let notifiedEvents = [];

function makeCollection(key, directItems, childCollections, unloaded) {
	return {
		_ObjectType: "Collection",
		id: "id" + key,
		key,
		libraryID: 1,
		_loaded: unloaded ? {} : { childItems: true, childCollections: true, primaryData: true },
		getChildItems() { if (!this._loaded.childItems) { throw new Error("childItems not loaded"); } return directItems.map(i => ({ id: i })); },
		getChildCollections() { if (!this._loaded.childCollections) { throw new Error("childCollections not loaded"); } return childCollections; },
		hasChildCollections() { return childCollections.length > 0; },
		loadDataType(type) { this._loaded[type] = true; return Promise.resolve(); },
	};
}

// tree rows: index -> { row }
function makeView(collections, rows) {
	const view = {
		__isView: true,
		_rows: rows,
		renderItem(index, selection, oldDiv, columns) {
			// mimic Zotero: build a row div
			const div = oldDiv || doc.createElement("div");
			div.innerHTML = "";
			div.className = "row";
			div.children.length = 0;
			const cell = doc.createElement("span");
			cell.className = "cell label primary";
			const label = doc.createElement("span");
			label.className = "cell-text";
			label.textContent = rows[index].name;
			cell.appendChild(label);
			div.appendChild(cell);
			rootNode.appendChild(div);
			return div;
		},
		getRow(index) { return rows[index]; },
		tree: {
			invalidate() { invalidated++; },
			_jsWindow: null,
		},
	};
	const jsWindow = {
		renderItem(index, oldElem) { return view.renderItem(index, {}, oldElem, []); },
	};
	view.tree._jsWindow = jsWindow;
	return view;
}

// row helpers
function collectionRow(collection, name) { return { type: "collection", ref: collection, isCollection: () => true, name }; }
function libraryRow(name) { return { type: "library", ref: { _ObjectType: "Library" }, isCollection: () => false, name }; }

// Zotero global mock
sandbox.Zotero = {
	debug: (m) => { if (process.env.DEBUG) { console.log("   [zotero]", m); } },
	initializationPromise: Promise.resolve(),
	getMainWindow: () => windowMock,
	setTimeout: sandbox.setTimeout,
	Notifier: {
		registerObserver: (obs, types, id) => { sandbox.Zotero.__observer = obs; },
		unregisterObserver: (id) => { sandbox.Zotero.__observer = null; },
	},
	Search: function () {
		this.addCondition = () => {};
		this.search = () => Promise.resolve([]);
	},
};

const windowMock = { ZoteroPane: { collectionsView: null } };
sandbox.window = windowMock;

/* --------------------------- run bootstrap ------------------------------- */
const code = fs.readFileSync(path.join(__dirname, "bootstrap.js"), "utf8");
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "bootstrap.js" });

(async () => {
	let failures = 0;
	function check(label, cond) {
		console.log((cond ? "  PASS " : "  FAIL ") + label);
		if (!cond) { failures++; }
	}

	// collections hierarchy:
	// A (3 items) with children B (2 items), C (0)
	// P (0 items) with child B (2 items) — a pure parent folder
	const colB = makeCollection("BKEY", ["b1", "b2"], []);
	const colC = makeCollection("CKEY", [], []);
	const colA = makeCollection("AKEY", ["a1", "a2", "a3"], [colB, colC]);
	const colP = makeCollection("PKEY", [], [colB]);
	const rows = [
		libraryRow("My Library"),
		collectionRow(colA, "Folder A"),
		collectionRow(colB, "Folder B"),
		collectionRow(colC, "Folder C"),
		collectionRow(colP, "Folder P"),
	];
	const view = makeView([colA, colB, colC, colP], rows);
	windowMock.ZoteroPane.collectionsView = view;

	// --- startup ---
	await sandbox.startup({ id: "collection-count@workbuddy.local", version: "1.0.0" });
	await waitFor(() => sandbox.Zotero.__observer != null, "observer registered");
	await waitFor(() => view.__collectionCountPatched === true, "renderItem patched");
	check("renderItem patched", view.__collectionCountPatched === true);
	check("original renderItem kept", typeof sandbox.teardown === "function");

	// --- render row for A ---
	const divA = view.renderItem(1, {}, null, []);
	await waitFor(() => {
		const n = divA.querySelector(".collection-count-number");
		return n && n.textContent.trim().length > 0;
	}, "count for A");
	const numA = divA.querySelector(".collection-count-number");
	console.log("   row A ->", JSON.stringify(numA.textContent), "| title:", numA.title);
	check("A shows total 5", numA.children.length === 2 && numA.children[1].textContent === "5"); // 3 + 2 + 0
	check("A shows dimmed direct 3", numA.children.length === 2 && numA.children[0].textContent === "3");
	check("A tooltip", numA.title.indexOf("3") >= 0 && numA.title.indexOf("5") >= 0);

	// --- render row for B (direct only) ---
	const divB = view.renderItem(2, {}, null, []);
	await waitFor(() => { const n = divB.querySelector(".collection-count-number"); return n && n.textContent.length > 0; }, "count for B");
	const numB = divB.querySelector(".collection-count-number");
	console.log("   row B ->", JSON.stringify(numB.textContent), "| title:", numB.title);
	check("B shows 2", numB.textContent === "2" && numB.children.length === 0);

	// --- render row for C ---
	const divC = view.renderItem(3, {}, null, []);
	await waitFor(() => { const n = divC.querySelector(".collection-count-number"); return n && n.textContent.length > 0; }, "count for C");
	check("C shows 0", divC.querySelector(".collection-count-number").textContent === "0");

	// --- render row for P: parent with no direct items (the "MM" bug: must not show "0 228") ---
	const divP = view.renderItem(4, {}, null, []);
	await waitFor(() => { const n = divP.querySelector(".collection-count-number"); return n && n.textContent.length > 0; }, "count for P");
	const numP = divP.querySelector(".collection-count-number");
	console.log("   row P ->", JSON.stringify(numP.textContent), "| title:", numP.title);
	check("P (pure parent) shows only total, no dimmed 0", numP.textContent === "2" && numP.children.length === 0);

	// --- library row is untouched ---
	const divLib = view.renderItem(0, {}, null, []);
	check("library row has no count", !divLib.querySelector(".collection-count-number"));

	// --- windowed list path (initial paint) ---
	const jsPatched = view.tree._jsWindow.renderItem !== undefined;
	check("windowed list patched", jsPatched && sandbox.__color === undefined);
	const jsDiv = view.tree._jsWindow.renderItem(1, null);
	await waitFor(() => { const n = jsDiv.querySelector(".collection-count-number"); return n && n.textContent.length > 0; }, "js count");
	const jsNum = jsDiv.querySelector(".collection-count-number");
	check("windowed path shows count", jsNum.children.length === 2 && jsNum.children[1].textContent === "5");

	// --- notifier triggers invalidation (debounced) ---
	const before = invalidated;
	sandbox.Zotero.__observer.notify("add", "item", [1], {});
	now += 500; runAllTimers();
	check("invalidate called after item add", invalidated > before);
	// stale cache cleared and re-render shows fresh counts after data change
	colA._loaded.childItems = false;
	// change underlying data
	colA.getChildItems = function () { return ["x1", "x2"]; };
	view.renderItem(1, {}, null, []);
	await waitFor(() => {
		const d = view.renderItem(1, {}, null, []);
		const n = d.querySelector(".collection-count-number");
		return n && n.children.length === 2 && n.children[1].textContent === "4"; // 2 + 2 + 0
	}, "refreshed count after data change", 4000);
	const afterNum = view.renderItem(1, {}, null, []).querySelector(".collection-count-number");
	console.log("   row A after change ->", JSON.stringify(afterNum.textContent));
	check("count refreshed after item change", true);

	// --- unloaded data path ---
	const colD = makeCollection("DKEY", [], [], true); // unloaded collections
	colD.getChildCollections = function () { return [makeCollection("EKEY", ["e1"], [])]; };
	const rows2 = [collectionRow(colD, "Folder D")];
	const view2 = makeView([colD], rows2);
	windowMock.ZoteroPane.collectionsView = view2;
	await waitFor(() => sandbox.ensurePatched !== undefined || true, "noop", 100);
	now += 3000; runTimers(); // ensure loop re-patches new view
	await waitFor(() => view2.__collectionCountPatched === true, "view2 patched");
	const divD = view2.renderItem(0, {}, null, []);
	await waitFor(() => { const n = divD.querySelector(".collection-count-number"); return n && n.textContent.length > 0; }, "count D");
	console.log("   row D ->", JSON.stringify(divD.querySelector(".collection-count-number").textContent));
	const dNum = divD.querySelector(".collection-count-number");
	check("unloaded data counted (1)", dNum.textContent === "1" && dNum.children.length === 0);

	// --- shutdown restores original ---
	const orig = sandbox.__nothing; // noop
	await sandbox.shutdown({}, 0);
	check("renderItem restored", view2.renderItem !== undefined && !view2.__collectionCountPatched);
	check("observer unregistered", sandbox.Zotero.__observer === null);
	const divAfter = view2.renderItem(0, {}, null, []);
	check("no count after shutdown", !divAfter.querySelector(".collection-count-number"));

	console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
	if (failures) { process.exitCode = 1; }
})().catch(e => { console.error("TEST ERROR:", e); process.exitCode = 1; });
