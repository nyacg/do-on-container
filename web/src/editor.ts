import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { yCollab } from "y-codemirror.next";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { bar, params, wsOrigin, setConn } from "./common";

const { backend, room } = params();
bar(backend, room, "editor.html");

const COLORS = ["#e11d48", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#0891b2"];
const color = COLORS[Math.floor(Math.random() * COLORS.length)];
const ydoc = new Y.Doc();
const provider = new WebsocketProvider(`${wsOrigin()}/${backend}/doc`, room, ydoc);
provider.awareness.setLocalStateField("user", { name: `anon-${Math.floor(Math.random() * 1000)}`, color, colorLight: color + "33" });
provider.on("status", (e: { status: string }) => setConn(e.status));
provider.on("sync", (synced: boolean) => synced && setConn("synced"));

const ytext = ydoc.getText("codemirror");
new EditorView({
  state: EditorState.create({
    doc: ytext.toString(),
    extensions: [basicSetup, EditorView.lineWrapping, yCollab(ytext, provider.awareness)],
  }),
  parent: document.getElementById("editor")!,
});
