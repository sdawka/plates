// Renders Block Kit (messages and the Home tab) as Slack-styled HTML for the README screenshots. Pure.
// Covers the block and element types Plates uses: section (text, fields, accessory), actions (buttons,
// static_select, overflow), context, header, divider.

type Obj = Record<string, unknown>;

export interface Person {
  name: string;
  /** Two letters on the avatar. */
  initials: string;
  color: string;
}

export interface ShownMessage {
  by: Person;
  time: string;
  /** Plain text (humans) or Block Kit blocks (the bot). */
  text?: string;
  blocks?: Obj[];
  /** Reactions shown under the message, e.g. ["✅ 1"]. */
  reactions?: string[];
  /** Indent as a thread reply. */
  reply?: boolean;
}

export const BOT: Person = { name: "Plates", initials: "🍽", color: "#f0e6d3" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Slack mrkdwn → HTML. Mentions resolve through `names`. */
export function mrkdwn(text: string, names: Record<string, string>): string {
  let s = text;
  // <!date^ts^{fmt}|fallback>, <url|label>, <url>, <@U>, <#C>
  s = s.replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, (_, fb: string) => `\u0000${fb}\u0000`);
  s = s.replace(/<(https?:[^|>]+)\|([^>]+)>/g, (_, u: string, l: string) => `\u0001${u}\u0002${l}\u0003`);
  s = s.replace(/<(https?:[^>]+)>/g, (_, u: string) => `\u0001${u}\u0002${u}\u0003`);
  s = s.replace(/<@([A-Z0-9]+)>/g, (_, id: string) => `\u0004${names[id] ?? id}\u0005`);
  s = esc(s);
  s = s.replace(/\u0000([^\u0000]*)\u0000/g, "$1");
  s = s.replace(/\u0001([^\u0002]*)\u0002([^\u0003]*)\u0003/g, '<a href="$1">$2</a>');
  s = s.replace(/\u0004([^\u0005]*)\u0005/g, '<span class="mention">@$1</span>');
  s = s.replace(/\*([^*\n]+)\*/g, "<b>$1</b>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:)!?]|$)/g, "$1<i>$2</i>");
  s = s.replace(/~([^~\n]+)~/g, "<s>$1</s>");
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\n/g, "<br>");
  return s;
}

const textOf = (t: unknown, names: Record<string, string>): string => {
  const o = t as { type?: string; text?: string } | undefined;
  if (!o?.text) return "";
  return o.type === "plain_text" ? esc(o.text) : mrkdwn(o.text, names);
};

function element(e: Obj, names: Record<string, string>): string {
  switch (e.type) {
    case "button": {
      const style = e.style === "primary" ? " primary" : e.style === "danger" ? " danger" : "";
      return `<button class="btn${style}">${textOf(e.text, names)}</button>`;
    }
    case "static_select":
      return `<button class="btn select">${textOf(e.placeholder, names) || "Choose"} <span class="chev">▾</span></button>`;
    case "overflow":
      return `<button class="btn overflow">⋯</button>`;
    case "users_select":
      return `<button class="btn select">${textOf(e.placeholder, names) || "Pick a person"} <span class="chev">▾</span></button>`;
    case "image":
      return `<img class="ctximg" src="${esc(String(e.image_url))}" alt="">`;
    default:
      return `<span class="unknown">${esc(String(e.type))}</span>`;
  }
}

export function block(b: Obj, names: Record<string, string>): string {
  switch (b.type) {
    case "header":
      return `<div class="bk-header">${textOf(b.text, names)}</div>`;
    case "divider":
      return `<hr class="bk-divider">`;
    case "section": {
      const text = b.text ? `<div class="bk-text">${textOf(b.text, names)}</div>` : "";
      const fields = Array.isArray(b.fields) ? `<div class="bk-fields">${(b.fields as Obj[]).map((f) => `<div>${textOf(f, names)}</div>`).join("")}</div>` : "";
      const acc = b.accessory ? `<div class="bk-accessory">${element(b.accessory as Obj, names)}</div>` : "";
      return `<div class="bk-section">${text}${fields}${acc}</div>`;
    }
    case "actions":
      return `<div class="bk-actions">${((b.elements as Obj[]) ?? []).map((e) => element(e, names)).join("")}</div>`;
    case "context":
      return `<div class="bk-context">${((b.elements as Obj[]) ?? []).map((e) => (e.type === "image" ? element(e, names) : `<span>${textOf(e, names)}</span>`)).join(" ")}</div>`;
    default:
      return `<div class="unknown">${esc(String(b.type))}</div>`;
  }
}

const avatar = (p: Person) => `<div class="avatar" style="background:${p.color}">${p.initials}</div>`;

export function message(m: ShownMessage, names: Record<string, string>): string {
  const body = m.blocks ? m.blocks.map((b) => block(b, names)).join("") : `<div class="bk-text">${mrkdwn(m.text ?? "", names)}</div>`;
  const reactions = m.reactions?.length ? `<div class="reactions">${m.reactions.map((r) => `<span class="reaction">${esc(r)}</span>`).join("")}</div>` : "";
  const app = m.by === BOT ? `<span class="app">APP</span>` : "";
  return `<div class="msg${m.reply ? " reply" : ""}">${avatar(m.by)}<div class="msg-body"><div class="msg-head"><b>${esc(m.by.name)}</b>${app}<span class="time">${esc(m.time)}</span></div>${body}${reactions}</div></div>`;
}

export const CSS = `
*{box-sizing:border-box} body{margin:0;background:#fff;font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;font-size:15px;line-height:1.46;color:#1d1c1d;-webkit-font-smoothing:antialiased}
.frame{width:760px;background:#fff;border:1px solid #ddd;border-radius:10px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.08)}
.titlebar{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #e2e2e2;font-weight:700;font-size:15px}
.titlebar .sub{font-weight:400;color:#616061;font-size:13px}
.thread-tag{font-size:13px;color:#616061;padding:10px 16px 0}
.msg{display:flex;gap:10px;padding:8px 16px}
.msg.reply{padding-left:16px}
.avatar{width:38px;height:38px;border-radius:8px;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:#1d1c1d}
.msg-body{flex:1;min-width:0}
.msg-head{display:flex;align-items:baseline;gap:6px;margin-bottom:1px}
.msg-head b{font-size:15px}
.app{font-size:10px;font-weight:700;color:#616061;background:#e8e8e8;border-radius:3px;padding:1px 4px;position:relative;top:-1px}
.time{font-size:12px;color:#616061}
.mention{background:#e8f5fa;color:#1264a3;border-radius:3px;padding:0 2px}
a{color:#1264a3;text-decoration:none}
code{font-family:Monaco,Menlo,monospace;font-size:12px;background:#f8f8f8;border:1px solid #e0e0e0;border-radius:3px;padding:1px 3px;color:#e01e5a}
.bk-header{font-size:20px;font-weight:800;margin:6px 0 4px}
.bk-divider{border:0;border-top:1px solid #ddd;margin:10px 0}
.bk-section{display:flex;align-items:flex-start;gap:12px;margin:4px 0}
.bk-section .bk-text{flex:1}
.bk-fields{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:4px 12px}
.bk-accessory{flex:none}
.bk-actions{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 4px}
.bk-context{font-size:12px;color:#616061;margin:4px 0}
.btn{font:inherit;font-size:13px;font-weight:700;padding:5px 12px;border-radius:4px;border:1px solid #bbb;background:#fff;color:#1d1c1d;cursor:default;display:inline-flex;align-items:center;gap:6px;line-height:1.3}
.btn.primary{background:#007a5a;border-color:#007a5a;color:#fff}
.btn.danger{background:#fff;border-color:#e01e5a;color:#e01e5a}
.btn.select{font-weight:400}
.btn.overflow{padding:5px 8px}
.chev{opacity:.7}
.reactions{display:flex;gap:6px;margin-top:6px}
.reaction{font-size:12px;background:#f2f8fc;border:1px solid #cfe3f1;color:#1264a3;border-radius:12px;padding:1px 8px}
.home{width:760px;background:#fff;border:1px solid #ddd;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.08);overflow:hidden}
.home .tabs{display:flex;gap:18px;padding:12px 20px 0;border-bottom:1px solid #e2e2e2;font-size:13px;color:#616061}
.home .tabs .on{color:#1d1c1d;font-weight:700;border-bottom:2px solid #1264a3;padding-bottom:8px}
.home .tabs span{padding-bottom:8px}
.home .body{padding:14px 20px 18px}
.unknown{color:#e01e5a;font-size:12px}
`;

export function page(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div style="padding:24px;display:inline-block">${inner}</div></body></html>`;
}

export function channelFrame(title: string, sub: string, messages: ShownMessage[], names: Record<string, string>): string {
  return `<div class="frame"><div class="titlebar"># ${esc(title)}<span class="sub">${esc(sub)}</span></div>${messages.map((m) => message(m, names)).join("")}<div style="height:10px"></div></div>`;
}

export function dmFrame(title: string, messages: ShownMessage[], names: Record<string, string>): string {
  return `<div class="frame"><div class="titlebar">${esc(title)}</div>${messages.map((m) => message(m, names)).join("")}<div style="height:10px"></div></div>`;
}

export function homeFrame(blocks: Obj[], names: Record<string, string>): string {
  return `<div class="home"><div class="titlebar">🍽 Plates<span class="sub">app</span></div><div class="tabs"><span class="on">Home</span><span>Messages</span><span>About</span></div><div class="body">${blocks.map((b) => block(b, names)).join("")}</div></div>`;
}
