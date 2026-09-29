// cdp-shot.ts — screenshot an HTML file via CDP (sandbox Chromium recipe).
// Usage: bun scripts/cdp-shot.ts <htmlfile> <out.png> [width] [height]
import { readFileSync, writeFileSync } from "fs";

const [htmlFile, outPng, wArg, hArg] = process.argv.slice(2);
const W = Number(wArg || 390), H = Number(hArg || 844);

const html = readFileSync(htmlFile, "utf8");
const dataUrl = "data:text/html," + encodeURIComponent(html);

// launch chromium with remote debugging
const proc = Bun.spawn(["/opt/meta-chromium/chrome", "--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9222", "--user-data-dir=/tmp/sefu-cdp-profile"],
  { stdout: "ignore", stderr: "ignore" });
await new Promise((r) => setTimeout(r, 1500));

const target: any = await (await fetch("http://localhost:9222/json/new", { method: "PUT", body: "{}" })).json();
const wsUrl = target.webSocketDebuggerUrl;
if (!wsUrl) throw new Error("no debugger url: " + JSON.stringify(target).slice(0, 200));
const ws = new WebSocket(wsUrl);
let msgId = 0;
const pending = new Map<number, (v: any) => void>();
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
  };
});
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: true });
await send("Page.navigate", { url: dataUrl });
await new Promise((r) => setTimeout(r, 2500)); // let boot + postamble settle
const shot: any = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(outPng, Buffer.from(shot.data, "base64"));
console.log("wrote", outPng);
ws.close();
proc.kill();
process.exit(0);
