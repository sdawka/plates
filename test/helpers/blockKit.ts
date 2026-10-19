// Block Kit validator that enforces the documented limits (api.slack.com/reference/block-kit).
// Returns a list of human-readable violations; the fake Slack turns a non-empty list into the
// documented `invalid_blocks` error, which makes slackCall throw and the test fail.

type Obj = Record<string, unknown>;
export type Surface = "message" | "home" | "modal";

const MAX_BLOCKS: Record<Surface, number> = { message: 50, home: 100, modal: 100 };

const ACTION_ELEMENTS = new Set([
  "button", "static_select", "multi_static_select", "external_select", "multi_external_select",
  "users_select", "multi_users_select", "conversations_select", "multi_conversations_select",
  "channels_select", "multi_channels_select", "overflow", "datepicker", "timepicker", "datetimepicker",
  "checkboxes", "radio_buttons", "workflow_button", "email_text_input", "url_text_input", "number_input",
  "plain_text_input", "file_input", "rich_text_input",
]);
const SECTION_ACCESSORIES = new Set([
  "button", "image", "overflow", "datepicker", "timepicker", "static_select", "multi_static_select",
  "external_select", "multi_external_select", "users_select", "multi_users_select", "conversations_select",
  "multi_conversations_select", "channels_select", "multi_channels_select", "checkboxes", "radio_buttons",
  "workflow_button",
]);
const INPUT_ELEMENTS = new Set([
  "plain_text_input", "email_text_input", "url_text_input", "number_input", "static_select", "multi_static_select",
  "external_select", "multi_external_select", "users_select", "multi_users_select", "conversations_select",
  "multi_conversations_select", "channels_select", "multi_channels_select", "datepicker", "timepicker",
  "datetimepicker", "checkboxes", "radio_buttons", "file_input", "rich_text_input",
]);
const BLOCK_TYPES = new Set(["section", "divider", "image", "actions", "context", "input", "header", "rich_text", "file", "video", "markdown"]);

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

class Collector {
  readonly errors: string[] = [];
  constructor(private path: string[] = []) {}
  at(...p: string[]): Collector {
    const c = new Collector([...this.path, ...p]);
    (c as { errors: string[] }).errors = this.errors;
    return c;
  }
  fail(msg: string): void {
    this.errors.push(`${this.path.join(".") || "(root)"}: ${msg}`);
  }
}

function text(c: Collector, v: unknown, opts: { max: number; plainOnly?: boolean; required?: boolean; min?: number }): void {
  if (v === undefined) {
    if (opts.required) c.fail("text object is required");
    return;
  }
  if (!isObj(v)) return c.fail("must be a text object");
  if (v.type !== "plain_text" && v.type !== "mrkdwn") return c.fail(`text object type must be plain_text or mrkdwn (got ${String(v.type)})`);
  if (opts.plainOnly && v.type !== "plain_text") return c.fail("must be plain_text");
  if (typeof v.text !== "string") return c.fail("text is required");
  if (v.text.length < (opts.min ?? 1)) c.fail("text must be at least 1 character");
  if (v.text.length > opts.max) c.fail(`text is ${v.text.length} chars, max ${opts.max}`);
  if (v.type === "mrkdwn" && "emoji" in v) c.fail("emoji is only valid on plain_text");
}

function optionObj(c: Collector, o: unknown, kind: "option" | "overflow"): void {
  if (!isObj(o)) return c.fail("option must be an object");
  text(c.at("text"), o.text, { max: 75, required: true, plainOnly: kind === "overflow" || undefined });
  if (typeof o.value !== "string" || o.value.length === 0) c.at("value").fail("value is required");
  else if (o.value.length > 150) c.at("value").fail(`value is ${o.value.length} chars, max 150`);
  if (o.description !== undefined) text(c.at("description"), o.description, { max: 75, plainOnly: true });
}

function actionId(c: Collector, el: Obj, seen: Set<string> | null, required: boolean): void {
  const id = el.action_id;
  if (id === undefined) {
    if (required) c.fail("action_id is required");
    return;
  }
  if (typeof id !== "string" || id.length === 0) return c.fail("action_id must be a non-empty string");
  if (id.length > 255) c.fail(`action_id is ${id.length} chars, max 255`);
  if (seen) {
    if (seen.has(id)) c.fail(`duplicate action_id "${id}" within the block`);
    seen.add(id);
  }
}

function element(c: Collector, el: unknown, seen: Set<string> | null, ctx: { input?: boolean }): void {
  if (!isObj(el)) return c.fail("element must be an object");
  const t = el.type;
  if (typeof t !== "string") return c.fail("element type is required");
  const allowed = ctx.input ? INPUT_ELEMENTS : ACTION_ELEMENTS;
  if (!allowed.has(t) && t !== "image" && t !== "overflow") return c.fail(`element type "${t}" is not allowed here`);
  actionId(c, el, seen, t !== "image" && !(t === "button" && typeof el.url === "string"));
  if (t !== "image" && el.placeholder !== undefined) text(c.at("placeholder"), el.placeholder, { max: 150, plainOnly: true });

  switch (t) {
    case "button":
      text(c.at("text"), el.text, { max: 75, required: true, plainOnly: true });
      if (el.value !== undefined && (typeof el.value !== "string" || el.value.length > 2000)) c.at("value").fail("value must be a string of at most 2000 chars");
      if (el.url !== undefined && (typeof el.url !== "string" || el.url.length > 3000)) c.at("url").fail("url must be at most 3000 chars");
      if (el.style !== undefined && el.style !== "primary" && el.style !== "danger") c.at("style").fail("style must be primary or danger");
      break;
    case "overflow": {
      const opts = el.options;
      if (!Array.isArray(opts)) return c.at("options").fail("options is required");
      if (opts.length < 2 || opts.length > 5) c.at("options").fail(`overflow needs 2 to 5 options (got ${opts.length})`);
      opts.forEach((o, i) => optionObj(c.at(`options[${i}]`), o, "overflow"));
      break;
    }
    case "static_select":
    case "multi_static_select": {
      const { options, option_groups: groups } = el;
      if (options !== undefined && groups !== undefined) c.fail("options and option_groups are mutually exclusive");
      if (!Array.isArray(options) && !Array.isArray(groups)) return c.fail("options or option_groups is required");
      const flat: Obj[] = [];
      if (Array.isArray(options)) {
        if (options.length > 100) c.at("options").fail(`static_select allows at most 100 options (got ${options.length})`);
        if (options.length === 0) c.at("options").fail("options must not be empty");
        options.forEach((o, i) => {
          optionObj(c.at(`options[${i}]`), o, "option");
          if (isObj(o)) flat.push(o);
        });
      } else if (Array.isArray(groups)) {
        if (groups.length > 100) c.at("option_groups").fail("at most 100 option groups");
        for (const g of groups) if (isObj(g) && Array.isArray(g.options)) for (const o of g.options) if (isObj(o)) flat.push(o);
      }
      const values = flat.map((o) => o.value);
      if (new Set(values).size !== values.length) c.at("options").fail("option values must be unique");
      if (t === "static_select" && el.initial_option !== undefined) {
        if (!isObj(el.initial_option) || !values.includes(el.initial_option.value)) c.at("initial_option").fail("initial_option must be one of options");
      }
      break;
    }
    case "checkboxes":
    case "radio_buttons": {
      const opts = el.options;
      if (!Array.isArray(opts) || opts.length === 0) return c.at("options").fail("options is required");
      if (opts.length > 10) c.at("options").fail(`${t} allows at most 10 options (got ${opts.length})`);
      opts.forEach((o, i) => optionObj(c.at(`options[${i}]`), o, "option"));
      const values = opts.map((o) => (isObj(o) ? o.value : undefined));
      const initial = t === "checkboxes" ? el.initial_options : el.initial_option === undefined ? undefined : [el.initial_option];
      if (Array.isArray(initial)) for (const o of initial) if (!isObj(o) || !values.includes(o.value)) c.at("initial_options").fail("initial option must be one of options");
      break;
    }
    case "datepicker":
      if (el.initial_date !== undefined && !(typeof el.initial_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(el.initial_date))) {
        c.at("initial_date").fail("initial_date must be YYYY-MM-DD");
      }
      break;
    case "datetimepicker":
      if (el.initial_date_time !== undefined && !Number.isInteger(el.initial_date_time)) c.at("initial_date_time").fail("must be a unix timestamp");
      break;
    case "plain_text_input":
      if (el.max_length !== undefined && !(Number.isInteger(el.max_length) && (el.max_length as number) <= 3000)) c.at("max_length").fail("max_length must be <= 3000");
      break;
    case "image":
      if (typeof el.image_url !== "string") c.at("image_url").fail("image_url is required");
      if (typeof el.alt_text !== "string") c.at("alt_text").fail("alt_text is required");
      break;
  }
}

function block(c: Collector, b: unknown, surface: Surface): void {
  if (!isObj(b)) return c.fail("block must be an object");
  const t = b.type;
  if (typeof t !== "string" || !BLOCK_TYPES.has(t)) return c.fail(`unknown block type "${String(t)}"`);
  if (b.block_id !== undefined && (typeof b.block_id !== "string" || b.block_id.length === 0 || b.block_id.length > 255)) {
    c.at("block_id").fail("block_id must be a string of 1 to 255 chars");
  }
  if (t === "input" && surface === "message") c.fail("input blocks are only allowed in modals and the Home tab");

  switch (t) {
    case "section": {
      const hasFields = b.fields !== undefined;
      if (b.text === undefined && !hasFields) c.fail("section needs text or fields");
      text(c.at("text"), b.text, { max: 3000 });
      if (hasFields) {
        if (!Array.isArray(b.fields) || b.fields.length === 0 || b.fields.length > 10) c.at("fields").fail("fields must have 1 to 10 items");
        else b.fields.forEach((f, i) => text(c.at(`fields[${i}]`), f, { max: 2000 }));
      }
      if (b.accessory !== undefined) {
        const acc = b.accessory;
        if (!isObj(acc) || typeof acc.type !== "string" || !SECTION_ACCESSORIES.has(acc.type)) c.at("accessory").fail("accessory type not allowed");
        else element(c.at("accessory"), acc, null, {});
      }
      break;
    }
    case "header":
      text(c.at("text"), b.text, { max: 150, required: true, plainOnly: true });
      break;
    case "context": {
      const els = b.elements;
      if (!Array.isArray(els) || els.length === 0) return c.at("elements").fail("elements is required");
      if (els.length > 10) c.at("elements").fail(`context allows at most 10 elements (got ${els.length})`);
      els.forEach((e, i) => {
        const cc = c.at(`elements[${i}]`);
        if (isObj(e) && e.type === "image") element(cc, e, null, {});
        else text(cc, e, { max: 3000, required: true });
      });
      break;
    }
    case "actions": {
      const els = b.elements;
      if (!Array.isArray(els) || els.length === 0) return c.at("elements").fail("elements is required");
      if (els.length > 25) c.at("elements").fail(`actions allows at most 25 elements (got ${els.length})`);
      const seen = new Set<string>();
      els.forEach((e, i) => element(c.at(`elements[${i}]`), e, seen, {}));
      break;
    }
    case "input": {
      text(c.at("label"), b.label, { max: 2000, required: true, plainOnly: true });
      if (b.hint !== undefined) text(c.at("hint"), b.hint, { max: 2000, plainOnly: true });
      if (b.optional !== undefined && typeof b.optional !== "boolean") c.at("optional").fail("optional must be a boolean");
      if (b.element === undefined) c.fail("input needs an element");
      else element(c.at("element"), b.element, null, { input: true });
      break;
    }
    case "image":
      if (typeof b.image_url !== "string") c.at("image_url").fail("image_url is required");
      if (typeof b.alt_text !== "string") c.at("alt_text").fail("alt_text is required");
      break;
  }
}

export function validateBlocks(blocks: unknown, surface: Surface): string[] {
  const c = new Collector();
  if (!Array.isArray(blocks)) {
    c.fail("blocks must be an array");
    return c.errors;
  }
  if (blocks.length > MAX_BLOCKS[surface]) c.fail(`too many blocks: ${blocks.length}, max ${MAX_BLOCKS[surface]} for a ${surface}`);
  const ids = new Set<string>();
  blocks.forEach((b, i) => {
    block(c.at(`blocks[${i}]`), b, surface);
    if (isObj(b) && typeof b.block_id === "string") {
      if (ids.has(b.block_id)) c.at(`blocks[${i}]`).fail(`duplicate block_id "${b.block_id}"`);
      ids.add(b.block_id);
    }
  });
  return c.errors;
}

export interface ViewCheck {
  errors: string[];
}

/** Modal / Home view envelope plus its blocks. */
export function validateView(view: unknown, expected: "modal" | "home"): string[] {
  const c = new Collector();
  if (!isObj(view)) return ["view must be an object"];
  if (view.type !== expected) c.at("type").fail(`view type must be "${expected}" (got ${String(view.type)})`);
  if (view.callback_id !== undefined && (typeof view.callback_id !== "string" || view.callback_id.length > 255)) c.at("callback_id").fail("callback_id must be at most 255 chars");
  if (view.private_metadata !== undefined && (typeof view.private_metadata !== "string" || view.private_metadata.length > 3000)) {
    c.at("private_metadata").fail("private_metadata must be at most 3000 chars");
  }
  if (view.external_id !== undefined && (typeof view.external_id !== "string" || view.external_id.length > 255)) c.at("external_id").fail("external_id must be at most 255 chars");
  const blocks = view.blocks;
  if (expected === "modal") {
    text(c.at("title"), view.title, { max: 24, required: true, plainOnly: true });
    if (view.submit !== undefined) text(c.at("submit"), view.submit, { max: 24, plainOnly: true });
    if (view.close !== undefined) text(c.at("close"), view.close, { max: 24, plainOnly: true });
    if (Array.isArray(blocks) && blocks.some((b) => isObj(b) && b.type === "input") && view.submit === undefined) {
      c.at("submit").fail("submit is required when the modal has input blocks");
    }
  }
  return [...c.errors, ...validateBlocks(blocks, expected)];
}
