// One JSON line per notable step, read by the plates-logs Tail Worker. Ids and kinds only: no message text.

export function info(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ msg, ...fields }));
}
