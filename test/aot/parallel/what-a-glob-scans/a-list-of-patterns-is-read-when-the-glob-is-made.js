// new Bun.Glob() reads an array of patterns in the call: a getter among its elements runs there, once, and what it throws is thrown by the call.
const order = [];
const patterns = ["*.ts", "placeholder"];
Object.defineProperty(patterns, 1, {
  get() {
    order.push("read");
    return "!a.*";
  },
});
order.push("before");
const glob = new Bun.Glob(patterns);
order.push("after");
patterns.length = 0;
console.log(order.join(), String(glob.match("a.ts")), String(glob.match("b.ts")), String(glob.match("b.js")));

function refusalOf(run) {
  try {
    return `nothing is thrown: ${typeof run()}`;
  } catch (error) {
    return `${error.name} ${String(error.code)} ${error.message}`;
  }
}

const throws = ["*.ts"];
Object.defineProperty(throws, 0, {
  get() {
    throw new RangeError("thrown by a getter");
  },
});
console.log(refusalOf(() => new Bun.Glob(5)));
console.log(refusalOf(() => new Bun.Glob(["*.ts", 5])));
console.log(refusalOf(() => new Bun.Glob(new Proxy(["*.ts"], {}))));
console.log(refusalOf(() => new Bun.Glob(throws)));
console.log(refusalOf(() => new Bun.Glob(["*.ts", "a\0b"]).scan(".")));

const folder = process.platform === "win32" ? "C:/Windows/System32/drivers/etc" : "/etc";
const list = new Bun.Glob(["hosts", "no-file-has-this-name", "host?", "!*.conf"]);
console.log([...list.scanSync(folder)].join(), (await Array.fromAsync(list.scan({ cwd: folder }))).join());
console.log(
  [...new Bun.Glob([]).scanSync("/a-folder-that-is-not-there/made-up")].length,
  String(new Bun.Glob(["!hosts"]).match("hosts")),
  String(new Bun.Glob("!hosts").match("passwd")),
);
