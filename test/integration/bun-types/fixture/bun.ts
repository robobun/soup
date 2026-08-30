import type { BunFile, BunPlugin, FileBlob } from "bun";
import * as tsd from "./utilities";
{
  const _plugin: BunPlugin = {
    name: "asdf",
    setup() {},
  };
  _plugin;
}

{
  // tslint:disable-next-line:no-void-expression
  const arg = Bun.plugin({
    name: "arg",
    setup() {},
  });

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  tsd.expectType<void>(arg);
}

{
  // tslint:disable-next-line:no-void-expression
  const arg = Bun.plugin({
    name: "arg",
    async setup() {},
  });

  tsd.expectType<Promise<void>>(arg);
}

{
  const f = Bun.file("asdf");
  tsd.expectType<BunFile>(f);
  tsd.expectType<FileBlob>(f);
}
{
  Bun.spawn(["anything"], {
    env: process.env,
  });
  Bun.spawn(["anything"], {
    env: { ...process.env },
  });
  Bun.spawn(["anything"], {
    env: { ...process.env, dummy: "" },
  });
}
{
  Bun.TOML.parse("asdf = asdf");
}

DOMException;

tsd
  .expectType(
    Bun.secrets.get({
      service: "hey",
      name: "hey",
    }),
  )
  .is<Promise<string | null>>();

tsd
  .expectType(
    Bun.secrets.set({
      service: "hey",
      name: "hey",
      value: "hey",
      allowUnrestrictedAccess: true,
    }),
  )
  .is<Promise<void>>();

tsd
  .expectType(
    Bun.secrets.delete({
      service: "hey",
      name: "hey",
    }),
  )
  .is<Promise<boolean>>();

tsd
  .expectType(
    Bun.mmap("./data.bin", {
      shared: true,
      sync: false,
      offset: 4096,
      size: 1024,
    }),
  )
  .is<Uint8Array<ArrayBuffer>>();

tsd.expectType(Bun.mmap("./data.bin", { offset: 4096 })).is<Uint8Array<ArrayBuffer>>();
tsd.expectType(Bun.mmap("./data.bin", { size: 1024 })).is<Uint8Array<ArrayBuffer>>();

tsd.expectType(Bun.semver.parse("1.2.3")).is<Bun.semver.Version | null>();
tsd.expectType(Bun.semver.parse(undefined)).is<Bun.semver.Version | null>();
tsd.expectType(Bun.semver.parse("1.2.3")!.prerelease).is<(string | number)[]>();
tsd.expectType(Bun.semver.parse("1.2.3")!.build).is<string[]>();
tsd.expectType(Bun.semver.parse("1.2.3")!.version).is<string>();
tsd.expectType(Bun.semver.inc("1.2.3", "minor")).is<string | null>();
tsd.expectType(Bun.semver.inc("1.2.3", "prerelease", "beta", "1")).is<string | null>();
tsd.expectType(Bun.semver.inc("1.2.3", "prerelease", "beta", false)).is<string | null>();
// @ts-expect-error release must be one of the node-semver release types
Bun.semver.inc("1.2.3", "bump");
tsd.expectType(Bun.semver.maxSatisfying(["1.2.3", "1.3.0"], "^1.0.0")).is<string | null>();
tsd.expectType(Bun.semver.minSatisfying(["1.2.3", "1.3.0"], "^1.0.0")).is<string | null>();

new Bun.Glob("**/*.ts").scan({ ignore: "node_modules/**" }) satisfies AsyncIterableIterator<string>;
new Bun.Glob("**/*.ts").scanSync({ ignore: ["node_modules/**", "dist/**"] }) satisfies IterableIterator<string>;
// @ts-expect-error ignore takes glob pattern strings
new Bun.Glob("**/*.ts").scanSync({ ignore: /node_modules/ });
