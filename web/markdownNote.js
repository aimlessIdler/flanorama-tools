import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ---------- Copy-button injection ----------
function injectCopyButtons(container) {
    const blocks = container.querySelectorAll("pre > code");
    blocks.forEach((code) => {
        const pre = code.parentElement;
        if (pre.querySelector(".md-copy-btn")) return;
        pre.classList.add("md-has-copy");

        const btn = document.createElement("button");
        btn.className = "md-copy-btn";
        btn.type = "button";
        btn.textContent = "Copy";
        btn.title = "Copy code to clipboard";

        btn.addEventListener("mousedown", (e) => e.stopPropagation());
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            e.preventDefault();
            const text = code.textContent;
            try {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text);
                } else {
                    // Fallback
                    const ta = document.createElement("textarea");
                    ta.value = text;
                    ta.style.position = "fixed";
                    ta.style.opacity = "0";
                    document.body.appendChild(ta);
                    ta.select();
                    try {
                        if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
                    } finally {
                        ta.remove();
                    }
                }
                btn.textContent = "Copied";
                btn.classList.add("md-copy-ok");
            } catch {
                btn.textContent = "Failed";
                btn.classList.add("md-copy-err");
            }
            setTimeout(() => {
                btn.textContent = "Copy";
                btn.classList.remove("md-copy-ok", "md-copy-err");
            }, 1200);
        });

        pre.appendChild(btn);
    });
}

// ---------- One-time stylesheet ----------
const STYLE_ID = "md-note-style";
function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.md-note-root {
    width: 100%; height: 100%;
    box-sizing: border-box;
    display: flex; flex-direction: column;
    color: var(--input-text, #ddd);
    font-family: var(--font-family, system-ui, sans-serif);
    background: var(--comfy-input-bg, #1e1e1e);
    border-radius: 4px;
    overflow: hidden;
}
.md-note-toolbar {
    display: flex; gap: 4px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--border-color, #444);
    background: var(--comfy-menu-bg, #2a2a2a);
    flex: 0 0 auto;
}
.md-note-toolbar button {
    background: var(--comfy-input-bg, #333);
    color: var(--input-text, #ddd);
    border: 1px solid var(--border-color, #555);
    border-radius: 3px;
    padding: 2px 10px;
    cursor: pointer;
    font-size: 11px;
    line-height: 1.4;
}
.md-note-toolbar button:hover {
    background: var(--border-color, #444);
}
.md-note-toolbar button.active {
    background: var(--p-primary-color, #4a90e2);
    border-color: var(--p-primary-color, #4a90e2);
    color: #fff;
}
.md-note-body {
    flex: 1 1 auto;
    overflow: auto;
    padding: 8px 10px;
    box-sizing: border-box;
    min-height: 0;
}
.md-note-body textarea {
    width: 100%; height: 100%;
    background: transparent;
    color: var(--input-text, #ddd);
    border: none; outline: none; resize: none;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.5;
    box-sizing: border-box;
    padding: 0;
}
.md-note-preview { font-size: 12.5px; line-height: 1.55; word-wrap: break-word; }
.md-note-preview > *:first-child { margin-top: 0; }
.md-note-preview > *:last-child { margin-bottom: 0; }
.md-note-preview h1, .md-note-preview h2, .md-note-preview h3,
.md-note-preview h4, .md-note-preview h5, .md-note-preview h6 {
    margin: 0.7em 0 0.3em;
    line-height: 1.25;
}
.md-note-preview h1 { font-size: 1.5em; border-bottom: 1px solid var(--border-color, #444); padding-bottom: 0.2em; }
.md-note-preview h2 { font-size: 1.3em; border-bottom: 1px solid var(--border-color, #444); padding-bottom: 0.15em; }
.md-note-preview h3 { font-size: 1.15em; }
.md-note-preview p { margin: 0.5em 0; }
.md-note-preview ul, .md-note-preview ol { padding-left: 1.5em; margin: 0.4em 0; }
.md-note-preview li { margin: 0.15em 0; }
.md-note-preview code {
    background: rgba(255,255,255,0.08);
    padding: 1px 5px;
    border-radius: 3px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.92em;
}
.md-note-preview pre {
    background: rgba(0,0,0,0.40);
    padding: 8px 10px;
    border-radius: 4px;
    overflow-x: auto;
    position: relative;
    margin: 0.5em 0;
    border: 1px solid var(--border-color, #333);
}
.md-note-preview pre code {
    background: transparent;
    padding: 0;
    display: block;
    font-size: 11.5px;
    line-height: 1.45;
    white-space: pre;
}
.md-note-preview blockquote {
    border-left: 3px solid var(--border-color, #555);
    margin: 0.5em 0;
    padding: 0.1em 10px;
    color: var(--descrip-text, #aaa);
}
.md-note-preview a { color: #6cc6ff; text-decoration: none; }
.md-note-preview a:hover { text-decoration: underline; }
.md-note-preview hr { border: none; border-top: 1px solid var(--border-color, #444); margin: 0.8em 0; }
.md-note-preview table { border-collapse: collapse; margin: 0.5em 0; }
.md-note-preview th, .md-note-preview td {
    border: 1px solid var(--border-color, #555);
    padding: 4px 8px;
}
.md-note-preview img { max-width: 100%; height: auto; }
.md-copy-btn {
    position: absolute;
    top: 4px; right: 4px;
    background: rgba(60,60,60,0.85);
    color: #eee;
    border: 1px solid #666;
    border-radius: 3px;
    padding: 1px 7px;
    font-size: 10px;
    line-height: 1.5;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s;
    font-family: inherit;
}
.md-note-preview pre:hover .md-copy-btn,
.md-copy-btn:focus { opacity: 1; }
.md-copy-btn:hover { background: rgba(90,90,90,0.95); }
.md-copy-btn.md-copy-ok { background: rgba(60,140,80,0.95); border-color: #5a9; }
.md-copy-btn.md-copy-err { background: rgba(160,60,60,0.95); border-color: #c66; }
.md-note-empty { color: var(--descrip-text, #888); font-style: italic; }
`;
    document.head.appendChild(style);
}

// ---------- Extension registration ----------
app.registerExtension({
    name: "comfy.markdownNote",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "FlaMarkdownNote") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            injectStyle();

            // Locate the underlying STRING widget and hide its default UI.
            // It remains the source of truth for serialization.
            const textWidget = this.widgets?.find((w) => w.name === "text");
            if (!textWidget) return r;

            const hiddenEl = textWidget.inputEl || textWidget.element;
            if (hiddenEl) hiddenEl.style.display = "none";
            textWidget.computeSize = () => [0, -4];
            textWidget.type = "hidden-string";
            textWidget.draw = () => {};

            // ----- Build DOM -----
            const root = document.createElement("div");
            root.className = "md-note-root";

            const toolbar = document.createElement("div");
            toolbar.className = "md-note-toolbar";

            const previewBtn = document.createElement("button");
            previewBtn.type = "button";
            previewBtn.textContent = "Preview";

            const editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.textContent = "Edit";

            toolbar.appendChild(previewBtn);
            toolbar.appendChild(editBtn);

            const body = document.createElement("div");
            body.className = "md-note-body";

            const textarea = document.createElement("textarea");
            textarea.spellcheck = false;
            textarea.value = textWidget.value ?? "";
            textarea.placeholder = "Write markdown here…";
            // Stop ComfyUI from intercepting key events (delete-node, etc.)
            ["keydown", "keyup", "keypress"].forEach((ev) =>
                textarea.addEventListener(ev, (e) => e.stopPropagation())
            );
            textarea.addEventListener("input", () => {
                textWidget.value = textarea.value;
            });

            const preview = document.createElement("div");
            preview.className = "md-note-preview";

            root.appendChild(toolbar);
            root.appendChild(body);

            let mode = "preview";
            let previewRequest;

            const renderPreview = async () => {
                previewRequest?.abort();
                const source = textarea.value;
                if (!source.trim()) {
                    preview.textContent = "Click Edit to add Markdown.";
                    return;
                }
                previewRequest = new AbortController();
                const { signal } = previewRequest;
                preview.textContent = "Rendering preview…";
                try {
                    const response = await api.fetchApi("/flanodes/markdown-preview", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ text: source }),
                        signal,
                    });
                    const { html, error } = await response.json();
                    if (signal.aborted) return;
                    if (!response.ok) throw new Error(error || "Preview unavailable");
                    // The local renderer escapes raw HTML and rejects unsafe link schemes.
                    preview.innerHTML = html;
                    for (const link of preview.querySelectorAll("a[href]")) {
                        link.target = "_blank";
                        link.rel = "noopener noreferrer";
                    }
                    injectCopyButtons(preview);
                } catch (err) {
                    if (!signal.aborted) preview.textContent = "Preview unavailable. " + err.message;
                }
            };

            const setMode = (m) => {
                mode = m;
                body.replaceChildren();
                previewBtn.setAttribute("aria-pressed", String(m === "preview"));
                editBtn.setAttribute("aria-pressed", String(m === "edit"));
                if (m === "edit") {
                    previewRequest?.abort();
                    body.appendChild(textarea);
                    editBtn.classList.add("active");
                    previewBtn.classList.remove("active");
                    setTimeout(() => textarea.focus(), 0);
                } else {
                    body.appendChild(preview);
                    previewBtn.classList.add("active");
                    editBtn.classList.remove("active");
                    renderPreview();
                }
            };

            previewBtn.addEventListener("click", () => setMode("preview"));
            editBtn.addEventListener("click", () => setMode("edit"));

            // ----- Attach as DOM widget -----
            const widget = this.addDOMWidget("markdown_view", "markdown_view", root, {
                serialize: false,
                hideOnZoom: false,
            });
            widget.computeSize = function (width) {
                return [width, Math.max(180, this.parent?.size?.[1] - 60 || 220)];
            };

            // Initial state
            setMode("preview");

            // Default sizing on first creation
            const minW = 320, minH = 220;
            if (!this.size || this.size[0] < minW) this.size = [Math.max(this.size?.[0] || 0, 380), this.size?.[1] || 280];
            if (this.size[1] < minH) this.size[1] = 280;

            // Re-sync when workflow loads
            const origOnConfigure = this.onConfigure;
            this.onConfigure = function () {
                origOnConfigure?.apply(this, arguments);
                textarea.value = textWidget.value ?? "";
                if (mode === "preview") renderPreview();
            };
            const onRemoved = this.onRemoved;
            this.onRemoved = function () {
                previewRequest?.abort();
                return onRemoved?.apply(this, arguments);
            };

            return r;
        };
    },
});
