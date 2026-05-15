// trivial tool fixture — body doesn't matter for the manifest loader test
export default async function echo(args: { msg: string }) { return { ok: true, msg: args.msg }; }
