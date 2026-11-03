import { camelCase, snakeCase } from "bun";

console.log(
  camelCase("two words"),
  Bun.capitalCase("two words"),
  Bun.constantCase("straße"),
  Bun.dotCase("ΟΔΟΣ ελλάς"),
  Bun.kebabCase("XMLHttpRequest"),
  Bun.pascalCase("σοφόςΣοφός λόγος"),
  snakeCase("created_at"),
  Bun.trainCase("ﬁle name"),
  // Longer than the buffer on the stack, in both encodings.
  snakeCase("fooBar ".repeat(60)).length,
  Bun.constantCase("λόγοςΈργον ".repeat(40)).length,
);
