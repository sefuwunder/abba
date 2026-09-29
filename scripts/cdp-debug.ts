// cdp-debug.ts — navigate and report console errors + body state.
import { readFileSync } from "fs";
const [htmlFile] = process.argv.slice(2);
const html = readFileSync(htmlFile, "utf8");
const dataUrl = "data:text/html," + encodeURIComponent(html);

const proc = Bun.spawn(["/opt/meta-chromium/chrome", "--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9223", "--user-data-dir=/tmp/sefu-cdp-dbg"],
  { stdout: "ignore", stderr: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const target: any = await (await fetch("http://localhost:9223/json/new", { method: "PUT", body: "{}" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map<number, (v: any) => void>();
const events: any[] = [];
function send(method: string, params: any = {}): Promise<any> {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await new Promise<void>((resolve) => {
  ws.onopen = () => resolve();
  ws.onmessage = (ev: any) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
    else if (m.method) events.push(m);
  };
});
await send("Runtime.enable");
await send("Log.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: "window.__errs=[]; window.onerror=function(m,s,l,c){window.__errs.push(m+' @'+l+':'+c);};",
});
await send("Page.navigate", { url: dataUrl });
await new Promise((r) => setTimeout(r, 3000));
const evalRes: any = await send("Runtime.evaluate", {
  expression: "JSON.stringify({errs: window.__errs, bodyLen: document.body.innerHTML.length, bodyStart: document.body.innerHTML.slice(0,200), title: document.title})",
  returnByValue: true,
});
console.log("PAGE:", evalRes.result?.value);
console.log("CONSOLE/EXC:", JSON.stringify(events.filter((e) => e.method === "Runtime.exceptionThrown" || e.method === "Log.entryAdded").slice(0, 5), null, 1).slice(0, 2000));
ws.close(); proc.kill(); process.exit(0);
