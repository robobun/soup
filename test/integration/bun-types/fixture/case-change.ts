import { camelCase, capitalCase, constantCase, dotCase, kebabCase, pascalCase, snakeCase, trainCase } from "bun";
import { expectType } from "./utilities";

expectType(camelCase("two words")).is<string>();
expectType(capitalCase("two words")).is<string>();
expectType(constantCase("two words")).is<string>();
expectType(dotCase("two words")).is<string>();
expectType(kebabCase("two words")).is<string>();
expectType(pascalCase("two words")).is<string>();
expectType(snakeCase("two words")).is<string>();
expectType(trainCase("two words")).is<string>();

expectType(Bun.camelCase("two words")).is<string>();
expectType(["createdAt", "updatedAt"].map(Bun.snakeCase)).is<string[]>();

// @ts-expect-error the functions take no options
Bun.camelCase("two words", { delimiter: "_" });
// @ts-expect-error input is a string
Bun.snakeCase(123);
// @ts-expect-error
Bun.kebabCase();
