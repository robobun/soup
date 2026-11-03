#pragma once

#include "root.h"

namespace Bun {

// `Bun.camelCase(input)` and the seven other case functions. Each splits `input` into words and
// joins them in one naming convention, and gives the output of the function of the same name in
// the `change-case` package. An argument that is not a string is converted to one first.
JSC_DECLARE_HOST_FUNCTION(jsFunctionBunCamelCase);
JSC_DECLARE_HOST_FUNCTION(jsFunctionBunCapitalCase);
JSC_DECLARE_HOST_FUNCTION(jsFunctionBunConstantCase);
JSC_DECLARE_HOST_FUNCTION(jsFunctionBunDotCase);
JSC_DECLARE_HOST_FUNCTION(jsFunctionBunKebabCase);
JSC_DECLARE_HOST_FUNCTION(jsFunctionBunPascalCase);
JSC_DECLARE_HOST_FUNCTION(jsFunctionBunSnakeCase);
JSC_DECLARE_HOST_FUNCTION(jsFunctionBunTrainCase);

} // namespace Bun
