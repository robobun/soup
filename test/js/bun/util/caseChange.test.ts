import { camelCase, capitalCase, constantCase, dotCase, kebabCase, pascalCase, snakeCase, trainCase } from "bun";
import { setSyntheticAllocationLimitForTesting } from "bun:internal-for-testing";
import { isRope, jscDescribe } from "bun:jsc";
import { describe, expect, test } from "bun:test";
import * as changeCase from "change-case";
import { bunEnv, bunExe, isASAN, isDebug, isWindows } from "harness";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const names = [
  "camelCase",
  "capitalCase",
  "constantCase",
  "dotCase",
  "kebabCase",
  "pascalCase",
  "snakeCase",
  "trainCase",
] as const;
type Name = (typeof names)[number];

// Bun gives what the package gives when the package does not read the locale of the host.
const reference = (name: Name, input: string) => changeCase[name](input, { locale: false });
const all = (input: string) => names.map(name => Bun[name](input));

// The text of `input` in a 16-bit string. A string that JavaScript makes from Latin-1 text is 8-bit.
const wide = (input: string) => Buffer.from(input, "utf16le").toString("utf16le");
const is8Bit = (value: string) => jscDescribe(value).includes("8Bit:(1)");

// A debug build runs the package about a hundred times slower than a release build.
const isSlowBuild = isDebug || isASAN;

// What change-case 5.4.4 returns, written down so that a reader sees the rules.
// Made with the package on Node.js 26 and on Bun. "against change-case" below compares each row with the package again.
// No letter here has a case mapping that is newer than Unicode 14: macOS maps letters with the ICU of the system.
// prettier-ignore
const vectors: string[][] = [
  // input, camelCase, capitalCase, constantCase, dotCase, kebabCase, pascalCase, snakeCase, trainCase
  ["two words", "twoWords", "Two Words", "TWO_WORDS", "two.words", "two-words", "TwoWords", "two_words", "Two-Words"],
  ["test", "test", "Test", "TEST", "test", "test", "Test", "test", "Test"],
  ["TEST", "test", "Test", "TEST", "test", "test", "Test", "test", "Test"],
  ["Test", "test", "Test", "TEST", "test", "test", "Test", "test", "Test"],
  ["a", "a", "A", "A", "a", "a", "A", "a", "A"],
  ["A", "a", "A", "A", "a", "a", "A", "a", "A"],
  ["test string", "testString", "Test String", "TEST_STRING", "test.string", "test-string", "TestString", "test_string", "Test-String"],
  ["test_string", "testString", "Test String", "TEST_STRING", "test.string", "test-string", "TestString", "test_string", "Test-String"],
  ["test-string", "testString", "Test String", "TEST_STRING", "test.string", "test-string", "TestString", "test_string", "Test-String"],
  ["test.string", "testString", "Test String", "TEST_STRING", "test.string", "test-string", "TestString", "test_string", "Test-String"],
  ["test/string", "testString", "Test String", "TEST_STRING", "test.string", "test-string", "TestString", "test_string", "Test-String"],
  ["test\tstring", "testString", "Test String", "TEST_STRING", "test.string", "test-string", "TestString", "test_string", "Test-String"],
  ["test\nstring", "testString", "Test String", "TEST_STRING", "test.string", "test-string", "TestString", "test_string", "Test-String"],
  ["  leading and trailing  ", "leadingAndTrailing", "Leading And Trailing", "LEADING_AND_TRAILING", "leading.and.trailing", "leading-and-trailing", "LeadingAndTrailing", "leading_and_trailing", "Leading-And-Trailing"],
  ["__private_field__", "privateField", "Private Field", "PRIVATE_FIELD", "private.field", "private-field", "PrivateField", "private_field", "Private-Field"],
  ["a--b__c..d", "aBCD", "A B C D", "A_B_C_D", "a.b.c.d", "a-b-c-d", "ABCD", "a_b_c_d", "A-B-C-D"],
  ["dot.case.input", "dotCaseInput", "Dot Case Input", "DOT_CASE_INPUT", "dot.case.input", "dot-case-input", "DotCaseInput", "dot_case_input", "Dot-Case-Input"],
  ["path/case/input", "pathCaseInput", "Path Case Input", "PATH_CASE_INPUT", "path.case.input", "path-case-input", "PathCaseInput", "path_case_input", "Path-Case-Input"],
  ["Train-Case-Input", "trainCaseInput", "Train Case Input", "TRAIN_CASE_INPUT", "train.case.input", "train-case-input", "TrainCaseInput", "train_case_input", "Train-Case-Input"],
  ["CONSTANT_CASE_INPUT", "constantCaseInput", "Constant Case Input", "CONSTANT_CASE_INPUT", "constant.case.input", "constant-case-input", "ConstantCaseInput", "constant_case_input", "Constant-Case-Input"],
  ["foo\u0000bar", "fooBar", "Foo Bar", "FOO_BAR", "foo.bar", "foo-bar", "FooBar", "foo_bar", "Foo-Bar"],
  ["!@#$%^&*()", "", "", "", "", "", "", "", ""],
  ["it's a 'quoted' word", "itSAQuotedWord", "It S A Quoted Word", "IT_S_A_QUOTED_WORD", "it.s.a.quoted.word", "it-s-a-quoted-word", "ItSAQuotedWord", "it_s_a_quoted_word", "It-S-A-Quoted-Word"],
  ["user@example.com", "userExampleCom", "User Example Com", "USER_EXAMPLE_COM", "user.example.com", "user-example-com", "UserExampleCom", "user_example_com", "User-Example-Com"],
  ["testString", "testString", "Test String", "TEST_STRING", "test.string", "test-string", "TestString", "test_string", "Test-String"],
  ["TestString", "testString", "Test String", "TEST_STRING", "test.string", "test-string", "TestString", "test_string", "Test-String"],
  ["camelCaseInput", "camelCaseInput", "Camel Case Input", "CAMEL_CASE_INPUT", "camel.case.input", "camel-case-input", "CamelCaseInput", "camel_case_input", "Camel-Case-Input"],
  ["PascalCaseInput", "pascalCaseInput", "Pascal Case Input", "PASCAL_CASE_INPUT", "pascal.case.input", "pascal-case-input", "PascalCaseInput", "pascal_case_input", "Pascal-Case-Input"],
  ["aB", "aB", "A B", "A_B", "a.b", "a-b", "AB", "a_b", "A-B"],
  ["Ab", "ab", "Ab", "AB", "ab", "ab", "Ab", "ab", "Ab"],
  ["AB", "ab", "Ab", "AB", "ab", "ab", "Ab", "ab", "Ab"],
  ["ABc", "aBc", "A Bc", "A_BC", "a.bc", "a-bc", "ABc", "a_bc", "A-Bc"],
  ["aBC", "aBc", "A Bc", "A_BC", "a.bc", "a-bc", "ABc", "a_bc", "A-Bc"],
  ["ABC", "abc", "Abc", "ABC", "abc", "abc", "Abc", "abc", "Abc"],
  ["ABCd", "abCd", "Ab Cd", "AB_CD", "ab.cd", "ab-cd", "AbCd", "ab_cd", "Ab-Cd"],
  ["ABcDEf", "aBcDEf", "A Bc D Ef", "A_BC_D_EF", "a.bc.d.ef", "a-bc-d-ef", "ABcDEf", "a_bc_d_ef", "A-Bc-D-Ef"],
  ["XMLHttpRequest", "xmlHttpRequest", "Xml Http Request", "XML_HTTP_REQUEST", "xml.http.request", "xml-http-request", "XmlHttpRequest", "xml_http_request", "Xml-Http-Request"],
  ["XMLParser", "xmlParser", "Xml Parser", "XML_PARSER", "xml.parser", "xml-parser", "XmlParser", "xml_parser", "Xml-Parser"],
  ["getHTTPSURL", "getHttpsurl", "Get Httpsurl", "GET_HTTPSURL", "get.httpsurl", "get-httpsurl", "GetHttpsurl", "get_httpsurl", "Get-Httpsurl"],
  ["parseJSON", "parseJson", "Parse Json", "PARSE_JSON", "parse.json", "parse-json", "ParseJson", "parse_json", "Parse-Json"],
  ["innerHTML", "innerHtml", "Inner Html", "INNER_HTML", "inner.html", "inner-html", "InnerHtml", "inner_html", "Inner-Html"],
  ["HTMLElement", "htmlElement", "Html Element", "HTML_ELEMENT", "html.element", "html-element", "HtmlElement", "html_element", "Html-Element"],
  ["IOError", "ioError", "Io Error", "IO_ERROR", "io.error", "io-error", "IoError", "io_error", "Io-Error"],
  ["PDFLoader", "pdfLoader", "Pdf Loader", "PDF_LOADER", "pdf.loader", "pdf-loader", "PdfLoader", "pdf_loader", "Pdf-Loader"],
  ["isHTTPS", "isHttps", "Is Https", "IS_HTTPS", "is.https", "is-https", "IsHttps", "is_https", "Is-Https"],
  ["version 1.2.10", "version_1_2_10", "Version 1 2 10", "VERSION_1_2_10", "version.1.2.10", "version-1-2-10", "Version_1_2_10", "version_1_2_10", "Version-1-2-10"],
  ["version1.2.10", "version1_2_10", "Version1 2 10", "VERSION1_2_10", "version1.2.10", "version1-2-10", "Version1_2_10", "version1_2_10", "Version1-2-10"],
  ["TestV2", "testV2", "Test V2", "TEST_V2", "test.v2", "test-v2", "TestV2", "test_v2", "Test-V2"],
  ["test123", "test123", "Test123", "TEST123", "test123", "test123", "Test123", "test123", "Test123"],
  ["123test", "123test", "123test", "123TEST", "123test", "123test", "123test", "123test", "123test"],
  ["123", "123", "123", "123", "123", "123", "123", "123", "123"],
  ["123 456", "123_456", "123 456", "123_456", "123.456", "123-456", "123_456", "123_456", "123-456"],
  ["a1b2c3", "a1b2c3", "A1b2c3", "A1B2C3", "a1b2c3", "a1b2c3", "A1b2c3", "a1b2c3", "A1b2c3"],
  ["A1B2C3", "a1B2C3", "A1 B2 C3", "A1_B2_C3", "a1.b2.c3", "a1-b2-c3", "A1B2C3", "a1_b2_c3", "A1-B2-C3"],
  ["1a2B3c", "1a2B3c", "1a2 B3c", "1A2_B3C", "1a2.b3c", "1a2-b3c", "1a2B3c", "1a2_b3c", "1a2-B3c"],
  ["test1Case", "test1Case", "Test1 Case", "TEST1_CASE", "test1.case", "test1-case", "Test1Case", "test1_case", "Test1-Case"],
  ["TEST1case", "test1case", "Test1case", "TEST1CASE", "test1case", "test1case", "Test1case", "test1case", "Test1case"],
  ["ES6Module", "es6Module", "Es6 Module", "ES6_MODULE", "es6.module", "es6-module", "Es6Module", "es6_module", "Es6-Module"],
  ["utf8Decode", "utf8Decode", "Utf8 Decode", "UTF8_DECODE", "utf8.decode", "utf8-decode", "Utf8Decode", "utf8_decode", "Utf8-Decode"],
  ["int32Array", "int32Array", "Int32 Array", "INT32_ARRAY", "int32.array", "int32-array", "Int32Array", "int32_array", "Int32-Array"],
  ["v2Beta1", "v2Beta1", "V2 Beta1", "V2_BETA1", "v2.beta1", "v2-beta1", "V2Beta1", "v2_beta1", "V2-Beta1"],
  ["h1 2go", "h1_2go", "H1 2go", "H1_2GO", "h1.2go", "h1-2go", "H1_2go", "h1_2go", "H1-2go"],
  ["1st place", "1stPlace", "1st Place", "1ST_PLACE", "1st.place", "1st-place", "1stPlace", "1st_place", "1st-Place"],
  ["3D model", "3DModel", "3 D Model", "3_D_MODEL", "3.d.model", "3-d-model", "3DModel", "3_d_model", "3-D-Model"],
  ["top 10 list", "top_10List", "Top 10 List", "TOP_10_LIST", "top.10.list", "top-10-list", "Top_10List", "top_10_list", "Top-10-List"],
  ["café au lait", "caféAuLait", "Café Au Lait", "CAFÉ_AU_LAIT", "café.au.lait", "café-au-lait", "CaféAuLait", "café_au_lait", "Café-Au-Lait"],
  ["CAFÉ AU LAIT", "caféAuLait", "Café Au Lait", "CAFÉ_AU_LAIT", "café.au.lait", "café-au-lait", "CaféAuLait", "café_au_lait", "Café-Au-Lait"],
  ["crèmeBrûlée", "crèmeBrûlée", "Crème Brûlée", "CRÈME_BRÛLÉE", "crème.brûlée", "crème-brûlée", "CrèmeBrûlée", "crème_brûlée", "Crème-Brûlée"],
  ["ÉcoleÀParis", "écoleÀParis", "École À Paris", "ÉCOLE_À_PARIS", "école.à.paris", "école-à-paris", "ÉcoleÀParis", "école_à_paris", "École-À-Paris"],
  ["straße", "straße", "Straße", "STRASSE", "straße", "straße", "Straße", "straße", "Straße"],
  ["ßeta gamma", "ßetaGamma", "SSeta Gamma", "SSETA_GAMMA", "ßeta.gamma", "ßeta-gamma", "SSetaGamma", "ßeta_gamma", "SSeta-Gamma"],
  ["großBuchstabe", "großBuchstabe", "Groß Buchstabe", "GROSS_BUCHSTABE", "groß.buchstabe", "groß-buchstabe", "GroßBuchstabe", "groß_buchstabe", "Groß-Buchstabe"],
  ["ÿes µm", "ÿes\u039cm", "\u0178es \u039cm", "\u0178ES_\u039cM", "ÿes.µm", "ÿes-µm", "\u0178es\u039cm", "ÿes_µm", "\u0178es-\u039cm"],
  ["µMeter", "µMeter", "\u039c Meter", "\u039c_METER", "µ.meter", "µ-meter", "\u039cMeter", "µ_meter", "\u039c-Meter"],
  ["10µm", "10µm", "10µm", "10\u039cM", "10µm", "10µm", "10µm", "10µm", "10µm"],
  ["naïve résumé", "naïveRésumé", "Naïve Résumé", "NAÏVE_RÉSUMÉ", "naïve.résumé", "naïve-résumé", "NaïveRésumé", "naïve_résumé", "Naïve-Résumé"],
  ["ÿFoo", "ÿFoo", "\u0178 Foo", "\u0178_FOO", "ÿ.foo", "ÿ-foo", "\u0178Foo", "ÿ_foo", "\u0178-Foo"],
  ["µMeter µmeter", "µMeter\u039cmeter", "\u039c Meter \u039cmeter", "\u039c_METER_\u039cMETER", "µ.meter.µmeter", "µ-meter-µmeter", "\u039cMeter\u039cmeter", "µ_meter_µmeter", "\u039c-Meter-\u039cmeter"],
  ["àÀà", "àÀà", "À Àà", "À_ÀÀ", "à.àà", "à-àà", "ÀÀà", "à_àà", "À-Àà"],
  ["foøBar", "foøBar", "Foø Bar", "FOØ_BAR", "foø.bar", "foø-bar", "FoøBar", "foø_bar", "Foø-Bar"],
  ["FOØBar", "foøBar", "Foø Bar", "FOØ_BAR", "foø.bar", "foø-bar", "FoøBar", "foø_bar", "Foø-Bar"],
  ["a×b", "aB", "A B", "A_B", "a.b", "a-b", "AB", "a_b", "A-B"],
  ["a÷b", "aB", "A B", "A_B", "a.b", "a-b", "AB", "a_b", "A-B"],
  ["1ª 2º", "1ª_2º", "1ª 2º", "1ª_2º", "1ª.2º", "1ª-2º", "1ª_2º", "1ª_2º", "1ª-2º"],
  ["ªBºC", "ªbºc", "ªbºc", "ªBºC", "ªbºc", "ªbºc", "ªbºc", "ªbºc", "ªbºc"],
  ["x²y", "xY", "X Y", "X_Y", "x.y", "x-y", "XY", "x_y", "X-Y"],
  ["½ cup", "cup", "Cup", "CUP", "cup", "cup", "Cup", "cup", "Cup"],
  ["non\u00a0breaking", "nonBreaking", "Non Breaking", "NON_BREAKING", "non.breaking", "non-breaking", "NonBreaking", "non_breaking", "Non-Breaking"],
  ["soft\u00adhyphen", "softHyphen", "Soft Hyphen", "SOFT_HYPHEN", "soft.hyphen", "soft-hyphen", "SoftHyphen", "soft_hyphen", "Soft-Hyphen"],
  ["ΟΔΟΣ ΣΣ", "οδοςΣσ", "Οδος Σσ", "ΟΔΟΣ_ΣΣ", "οδος.σς", "οδος-σς", "ΟδοςΣσ", "οδος_σς", "Οδος-Σσ"],
  ["ΟΔΥΣΣΕΥΣ", "οδυσσευς", "Οδυσσευς", "ΟΔΥΣΣΕΥΣ", "οδυσσευς", "οδυσσευς", "Οδυσσευς", "οδυσσευς", "Οδυσσευς"],
  ["A\u03a3", "a\u03c2", "A\u03c3", "A\u03a3", "a\u03c2", "a\u03c2", "A\u03c3", "a\u03c2", "A\u03c3"],
  ["a\u03a3b\u03a3", "a\u03a3b\u03a3", "A \u03a3b \u03a3", "A_\u03a3B_\u03a3", "a.\u03c3b.\u03c3", "a-\u03c3b-\u03c3", "A\u03a3b\u03a3", "a_\u03c3b_\u03c3", "A-\u03a3b-\u03a3"],
  ["αβγ Δέλτα", "αβγΔέλτα", "Αβγ Δέλτα", "ΑΒΓ_ΔΈΛΤΑ", "αβγ.δέλτα", "αβγ-δέλτα", "ΑβγΔέλτα", "αβγ_δέλτα", "Αβγ-Δέλτα"],
  ["σοφόςΣοφός", "σοφόςΣοφός", "Σοφός Σοφός", "ΣΟΦΌΣ_ΣΟΦΌΣ", "σοφός.σοφός", "σοφός-σοφός", "ΣοφόςΣοφός", "σοφός_σοφός", "Σοφός-Σοφός"],
  ["привет мир", "приветМир", "Привет Мир", "ПРИВЕТ_МИР", "привет.мир", "привет-мир", "ПриветМир", "привет_мир", "Привет-Мир"],
  ["приветМир", "приветМир", "Привет Мир", "ПРИВЕТ_МИР", "привет.мир", "привет-мир", "ПриветМир", "привет_мир", "Привет-Мир"],
  ["\u0130STANBUL", "i\u0307stanbul", "\u0130stanbul", "\u0130STANBUL", "i\u0307stanbul", "i\u0307stanbul", "\u0130stanbul", "i\u0307stanbul", "\u0130stanbul"],
  ["i\u0307stanbul", "iStanbul", "I Stanbul", "I_STANBUL", "i.stanbul", "i-stanbul", "IStanbul", "i_stanbul", "I-Stanbul"],
  ["\u0131\u015f\u0131k I\u015eIK", "\u0131\u015f\u0131kI\u015fik", "I\u015f\u0131k I\u015fik", "I\u015eIK_I\u015eIK", "\u0131\u015f\u0131k.i\u015fik", "\u0131\u015f\u0131k-i\u015fik", "I\u015f\u0131kI\u015fik", "\u0131\u015f\u0131k_i\u015fik", "I\u015f\u0131k-I\u015fik"],
  ["\u01c5abc \u01c6abc \u01c4ABC", "\u01c6abc\u01c4abc\u01c4abc", "\u01c4abc \u01c4abc \u01c4abc", "\u01c4ABC_\u01c4ABC_\u01c4ABC", "\u01c6abc.\u01c6abc.\u01c6abc", "\u01c6abc-\u01c6abc-\u01c6abc", "\u01c4abc\u01c4abc\u01c4abc", "\u01c6abc_\u01c6abc_\u01c6abc", "\u01c4abc-\u01c4abc-\u01c4abc"],
  ["\ufb01sh \ufb01Sh", "\ufb01shFISh", "FIsh FI Sh", "FISH_FI_SH", "\ufb01sh.\ufb01.sh", "\ufb01sh-\ufb01-sh", "FIshFISh", "\ufb01sh_\ufb01_sh", "FIsh-FI-Sh"],
  ["\u0149gama", "\u0149gama", "\u02bcNgama", "\u02bcNGAMA", "\u0149gama", "\u0149gama", "\u02bcNgama", "\u0149gama", "\u02bcNgama"],
  ["\u1e9eA \u1e9ea", "ßa\u1e9ea", "\u1e9ea \u1e9ea", "\u1e9eA_\u1e9eA", "ßa.ßa", "ßa-ßa", "\u1e9ea\u1e9ea", "ßa_ßa", "\u1e9ea-\u1e9ea"],
  ["\u65e5\u672c\u8a9eText", "\u65e5\u672c\u8a9etext", "\u65e5\u672c\u8a9etext", "\u65e5\u672c\u8a9eTEXT", "\u65e5\u672c\u8a9etext", "\u65e5\u672c\u8a9etext", "\u65e5\u672c\u8a9etext", "\u65e5\u672c\u8a9etext", "\u65e5\u672c\u8a9etext"],
  ["日本語 テキスト", "日本語テキスト", "日本語 テキスト", "日本語_テキスト", "日本語.テキスト", "日本語-テキスト", "日本語テキスト", "日本語_テキスト", "日本語-テキスト"],
  ["text\u65e5\u672c\u8a9e", "text\u65e5\u672c\u8a9e", "Text\u65e5\u672c\u8a9e", "TEXT\u65e5\u672c\u8a9e", "text\u65e5\u672c\u8a9e", "text\u65e5\u672c\u8a9e", "Text\u65e5\u672c\u8a9e", "text\u65e5\u672c\u8a9e", "Text\u65e5\u672c\u8a9e"],
  // A combining mark separates words. Scripts that write vowels or points as marks lose them, and their words are cut apart.
  ["\u0939\u093f\u0928\u094d\u0926\u0940", "\u0939\u0928\u0926", "\u0939 \u0928 \u0926", "\u0939_\u0928_\u0926", "\u0939.\u0928.\u0926", "\u0939-\u0928-\u0926", "\u0939\u0928\u0926", "\u0939_\u0928_\u0926", "\u0939-\u0928-\u0926"],
  ["\u0e17\u0e35\u0e48\u0e2d\u0e22\u0e39\u0e48 \u0e1c\u0e39\u0e49\u0e43\u0e0a\u0e49", "\u0e17\u0e2d\u0e22\u0e1c\u0e43\u0e0a", "\u0e17 \u0e2d\u0e22 \u0e1c \u0e43\u0e0a", "\u0e17_\u0e2d\u0e22_\u0e1c_\u0e43\u0e0a", "\u0e17.\u0e2d\u0e22.\u0e1c.\u0e43\u0e0a", "\u0e17-\u0e2d\u0e22-\u0e1c-\u0e43\u0e0a", "\u0e17\u0e2d\u0e22\u0e1c\u0e43\u0e0a", "\u0e17_\u0e2d\u0e22_\u0e1c_\u0e43\u0e0a", "\u0e17-\u0e2d\u0e22-\u0e1c-\u0e43\u0e0a"],
  ["\u0645\u064f\u062d\u064e\u0645\u064e\u0651\u062f \u0639\u064e\u0644\u0650\u064a\u0651", "\u0645\u062d\u0645\u062f\u0639\u0644\u064a", "\u0645 \u062d \u0645 \u062f \u0639 \u0644 \u064a", "\u0645_\u062d_\u0645_\u062f_\u0639_\u0644_\u064a", "\u0645.\u062d.\u0645.\u062f.\u0639.\u0644.\u064a", "\u0645-\u062d-\u0645-\u062f-\u0639-\u0644-\u064a", "\u0645\u062d\u0645\u062f\u0639\u0644\u064a", "\u0645_\u062d_\u0645_\u062f_\u0639_\u0644_\u064a", "\u0645-\u062d-\u0645-\u062f-\u0639-\u0644-\u064a"],
  ["cafe\u0301 au lait", "cafeAuLait", "Cafe Au Lait", "CAFE_AU_LAIT", "cafe.au.lait", "cafe-au-lait", "CafeAuLait", "cafe_au_lait", "Cafe-Au-Lait"],
  ["e\u0301cole", "eCole", "E Cole", "E_COLE", "e.cole", "e-cole", "ECole", "e_cole", "E-Cole"],
  ["\u4e16Abc", "\u4e16abc", "\u4e16abc", "\u4e16ABC", "\u4e16abc", "\u4e16abc", "\u4e16abc", "\u4e16abc", "\u4e16abc"],
  ["世界", "世界", "世界", "世界", "世界", "世界", "世界", "世界", "世界"],
  ["a\u0345b", "a\u0345b", "A\u0345b", "A\u0399B", "a\u0345b", "a\u0345b", "A\u0345b", "a\u0345b", "A\u0345b"],
  ["\u0345", "\u0345", "\u0399", "\u0399", "\u0345", "\u0345", "\u0399", "\u0345", "\u0399"],
  ["x\u0345", "x\u0345", "X\u0345", "X\u0399", "x\u0345", "x\u0345", "X\u0345", "x\u0345", "X\u0345"],
  ["\u2160\u2170 roman", "roman", "Roman", "ROMAN", "roman", "roman", "Roman", "roman", "Roman"],
  ["\u24b6\u24d0 circled", "circled", "Circled", "CIRCLED", "circled", "circled", "Circled", "circled", "Circled"],
  // Only 0 to 9 are digits. A digit of another script separates words.
  ["\u0661\u0662 digits", "digits", "Digits", "DIGITS", "digits", "digits", "Digits", "digits", "Digits"],
  ["\u58f2\u4e0a\uff12\uff10\uff12\uff14", "\u58f2\u4e0a", "\u58f2\u4e0a", "\u58f2\u4e0a", "\u58f2\u4e0a", "\u58f2\u4e0a", "\u58f2\u4e0a", "\u58f2\u4e0a", "\u58f2\u4e0a"],
  ["snow\u2603man", "snowMan", "Snow Man", "SNOW_MAN", "snow.man", "snow-man", "SnowMan", "snow_man", "Snow-Man"],
  ["emoji\u{1f600}Face", "emojiFace", "Emoji Face", "EMOJI_FACE", "emoji.face", "emoji-face", "EmojiFace", "emoji_face", "Emoji-Face"],
  ["\u{1f600}", "", "", "", "", "", "", "", ""],
  // The first letter of a capital word is one UTF-16 unit, so a first letter outside of the Basic Multilingual Plane keeps its case.
  ["\u{10428}bc \u{10400}BC", "\u{10428}bc\u{10400}bc", "\u{10428}bc \u{10400}bc", "\u{10400}BC_\u{10400}BC", "\u{10428}bc.\u{10428}bc", "\u{10428}bc-\u{10428}bc", "\u{10428}bc\u{10400}bc", "\u{10428}bc_\u{10428}bc", "\u{10428}bc-\u{10400}bc"],
  ["\u{1e922}\u{1e923}\u{1e924} \u{1e925}\u{1e926}", "\u{1e922}\u{1e923}\u{1e924}\u{1e925}\u{1e926}", "\u{1e922}\u{1e923}\u{1e924} \u{1e925}\u{1e926}", "\u{1e900}\u{1e901}\u{1e902}_\u{1e903}\u{1e904}", "\u{1e922}\u{1e923}\u{1e924}.\u{1e925}\u{1e926}", "\u{1e922}\u{1e923}\u{1e924}-\u{1e925}\u{1e926}", "\u{1e922}\u{1e923}\u{1e924}\u{1e925}\u{1e926}", "\u{1e922}\u{1e923}\u{1e924}_\u{1e925}\u{1e926}", "\u{1e922}\u{1e923}\u{1e924}-\u{1e925}\u{1e926}"],
  ["a\u{10400}b", "a\u{10400}b", "A \u{10400}b", "A_\u{10400}B", "a.\u{10428}b", "a-\u{10428}b", "A\u{10400}b", "a_\u{10428}b", "A-\u{10400}b"],
  ["\u{10400}\u{10401}\u{10428}", "\u{10428}\u{10401}\u{10428}", "\u{10400} \u{10401}\u{10428}", "\u{10400}_\u{10401}\u{10400}", "\u{10428}.\u{10429}\u{10428}", "\u{10428}-\u{10429}\u{10428}", "\u{10400}\u{10401}\u{10428}", "\u{10428}_\u{10429}\u{10428}", "\u{10400}-\u{10401}\u{10428}"],
  ["\u{1d400}\u{1d41a} math", "\u{1d400}\u{1d41a}Math", "\u{1d400}\u{1d41a} Math", "\u{1d400}\u{1d41a}_MATH", "\u{1d400}\u{1d41a}.math", "\u{1d400}\u{1d41a}-math", "\u{1d400}\u{1d41a}Math", "\u{1d400}\u{1d41a}_math", "\u{1d400}\u{1d41a}-Math"],
  ["\ud800abc", "abc", "Abc", "ABC", "abc", "abc", "Abc", "abc", "Abc"],
  ["abc\udc00Def", "abcDef", "Abc Def", "ABC_DEF", "abc.def", "abc-def", "AbcDef", "abc_def", "Abc-Def"],
  ["\ud801", "", "", "", "", "", "", "", ""],
  ["\udc00\ud801", "", "", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", "", ""],
  [" ", "", "", "", "", "", "", "", ""],
  ["\t\n", "", "", "", "", "", "", "", ""],
  ["_", "", "", "", "", "", "", "", ""],
  ["---", "", "", "", "", "", "", "", ""],
];

test("the reference is change-case 5.4.4", () => {
  const manifest = join(dirname(Bun.resolveSync("change-case", import.meta.dir)), "..", "package.json");
  expect(JSON.parse(readFileSync(manifest, "utf8")).version).toBe("5.4.4");
});

test("wide() makes a 16-bit string of Latin-1 text", () => {
  expect(is8Bit("straße")).toBe(true);
  expect(is8Bit(wide("straße"))).toBe(false);
  expect(wide("straße")).toBe("straße");
  expect(wide("abc\udc00Def")).toBe("abc\udc00Def");
});

describe("known answers", () => {
  test.each(vectors)("%j", (input, ...expected) => {
    expect(all(input)).toEqual(expected);
    expect(all(wide(input))).toEqual(expected);
  });
});

describe("against change-case", () => {
  test("the known answers are the package's", () => {
    for (const [input, ...expected] of vectors) {
      expect(names.map(name => reference(name, input))).toEqual(expected);
    }
  });

  test("a fixed set of random strings", () => {
    let seed = 0x2545f491;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed / 0x100000000;
    };
    const ascii = [..."abcdefgxyzABCDEFGXYZ0123456789 _-./:,;'\"!?()[]{}\t\n\0"];
    const latin1 = [..."ßÿµàÀéÉøØªº×÷²¼\u00a0\u00adþÞñÑ"];
    const letters = [
      ..."ΣσςΑαİıIi\u0307\u0345\u0301ǄǅǆﬁﬃŉẞևΐΰᾀᾈŸΜſ\u212a\u212b",
      ..."日本語ह\u093fन\u094dⅠⅰⒶⓐ١٢ʰ·’\u200d\u200b\ufeff\u3000ᲐაႠⰀⰰꙊꙋ",
    ];
    const astral = [
      "\u{10400}",
      "\u{10428}",
      "\u{1d400}",
      "\u{1d41a}",
      "\u{1e900}",
      "\u{1e922}",
      "\u{1f600}",
      "\u{20000}",
    ];
    const lone = ["\ud800", "\udbff", "\udc00", "\udfff"];
    const alphabets = [
      ascii,
      [..."abcABC12 _"],
      [...ascii, ...latin1],
      [...ascii, ...latin1, ...letters],
      [...ascii, ...letters, ...astral],
      [...ascii, ...latin1, ...letters, ...astral, ...lone],
      latin1,
      [..."ßÿµaA1 "],
      [..."ΣσςΑαaA \u0301\u0345"],
      [...astral, ...lone, ..."aA1 "],
    ];
    const differing: string[] = [];
    for (let i = 0; i < (isSlowBuild ? 300 : 4000); i++) {
      const alphabet = alphabets[i % alphabets.length];
      let input = "";
      for (let length = Math.floor(random() * random() * 48); length > 0; length--) {
        input += alphabet[Math.floor(random() * alphabet.length)];
      }
      for (const name of names) {
        const expected = reference(name, input);
        if (Bun[name](input) !== expected || Bun[name](wide(input)) !== expected) {
          differing.push(`${name}(${JSON.stringify(input)})`);
        }
      }
    }
    expect(differing).toEqual([]);
  });

  test("inputs longer than the buffer on the stack", () => {
    const inputs = [
      "fooBar ".repeat(200),
      "XMLHttpRequest_v2 ".repeat(80),
      "straße ÿes µm ".repeat(100),
      "ßA".repeat(400),
      "ΟΔΟΣ σοφός ".repeat(120),
      "日本語Text テキスト ".repeat(80),
      "\u{10400}\u{10428}a \u{1d400}b ".repeat(80),
      // One word, and its uppercase is three times as long.
      "ﬃ".repeat(500),
      "ΐ".repeat(300) + " " + "ΐx".repeat(150),
      "a".repeat(1000),
      "aB".repeat(500),
      "\ud800".repeat(600) + "x",
    ];
    for (const input of inputs) {
      for (const name of names) {
        const expected = reference(name, input);
        expect(Bun[name](input)).toBe(expected);
        expect(Bun[name](wide(input))).toBe(expected);
      }
    }
  });

  // The words depend on the class of every character, and src/jsc/bindings/caseChangeTables.h has the classes
  // that the regular expressions of the package see. This is the test that fails when the two no longer agree.
  test("every code point", () => {
    // A character after a lowercase letter and before an uppercase one, the other way around, and first in a
    // word. The four functions have the four ways to write a word.
    const contexts: [(character: string) => string, Name[]][] = [
      [character => "a" + character + "B", ["snakeCase", "constantCase"]],
      [character => "A" + character + "b", ["capitalCase"]],
      [character => character + character + "1", ["camelCase"]],
    ];
    const ranges: [number, number][] = isSlowBuild
      ? [
          [0x0000, 0x05ff],
          [0x1c80, 0x1cbf],
          [0x1e00, 0x1fff],
          [0x2c00, 0x2dff],
          [0xa640, 0xa7ff],
          [0xd7c0, 0xe03f],
          [0xfb00, 0xfb1f],
          [0xff00, 0xff5f],
          [0x10400, 0x1044f],
          [0x1d400, 0x1d44f],
          [0x1e900, 0x1e95f],
          [0x33440, 0x334bf],
          [0x10ff80, 0x10ffff],
        ]
      : [[0x0000, 0x10ffff]];
    const differing: string[] = [];
    const blockSize = 4096;
    for (const [first, last] of ranges) {
      for (let start = first; start <= last; start += blockSize) {
        const end = Math.min(start + blockSize - 1, last);
        for (const [context, functions] of contexts) {
          const pieces: string[] = [];
          for (let codePoint = start; codePoint <= end; codePoint++) {
            pieces.push(context(String.fromCodePoint(codePoint)));
          }
          // One call for the block. The block is taken apart only when the results differ.
          const text = pieces.join(" ");
          for (const name of functions) {
            if (Bun[name](text) === reference(name, text)) continue;
            for (const [index, piece] of pieces.entries()) {
              if (Bun[name](piece) !== reference(name, piece) && differing.length < 16) {
                differing.push(`U+${(start + index).toString(16).toUpperCase().padStart(4, "0")} in ${name}`);
              }
            }
          }
        }
      }
    }
    expect(
      differing,
      "caseChangeTables.h and the regular expression engine differ. Make the table again: bun bd scripts/generate-casechange-tables.mjs",
    ).toEqual([]);
  }, 60_000);
});

describe("arguments", () => {
  test.each(names)("Bun.%s is a function of one argument", name => {
    expect(typeof Bun[name]).toBe("function");
    expect(Bun[name].length).toBe(1);
    expect(Bun[name].name).toBe(name);
    expect(Object.getOwnPropertyDescriptor(Bun, name)).toEqual({
      value: Bun[name],
      writable: true,
      enumerable: true,
      configurable: false,
    });
  });

  test('import from "bun"', () => {
    const imported = { camelCase, capitalCase, constantCase, dotCase, kebabCase, pascalCase, snakeCase, trainCase };
    for (const name of names) {
      expect(typeof imported[name]).toBe("function");
      expect(imported[name]).toBe(Bun[name]);
    }
  });

  test("a value that is not a string is converted to one", () => {
    const call = (name: Name, ...values: unknown[]) => (Bun[name] as (...values: unknown[]) => string)(...values);
    expect(call("snakeCase", 123)).toBe("123");
    expect(call("snakeCase", 12.5)).toBe("12_5");
    expect(call("snakeCase", 10n)).toBe("10");
    expect(call("constantCase", true)).toBe("TRUE");
    expect(call("kebabCase", null)).toBe("null");
    expect(call("camelCase", undefined)).toBe("undefined");
    expect(call("camelCase")).toBe("undefined");
    expect(call("snakeCase", ["fooBar", "bazQux"])).toBe("foo_bar_baz_qux");
    expect(call("dotCase", { toString: () => "fooBar" })).toBe("foo.bar");
    expect(call("pascalCase", new String("foo bar"))).toBe("FooBar");
  });

  test("a symbol is a TypeError", () => {
    expect(() => (Bun.camelCase as (value: unknown) => string)(Symbol("fooBar"))).toThrow(
      new TypeError("Cannot convert a symbol to a string"),
    );
  });

  test("an error of toString() is the error of the call", () => {
    const error = new RangeError("from toString");
    let caught: unknown;
    try {
      (Bun.snakeCase as (value: unknown) => string)({
        toString() {
          throw error;
        },
      });
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBe(error);
  });

  test("arguments after the first are ignored", () => {
    expect(["fooBar", "bazQux"].map(Bun.snakeCase)).toEqual(["foo_bar", "baz_qux"]);
    expect((Bun.kebabCase as (...values: unknown[]) => string)("fooBar", { delimiter: "_" })).toBe("foo-bar");
  });
});

// ICU takes its default locale from LC_ALL, LC_MESSAGES and LANG. A case mapping with that locale changes I and i
// in Turkish and Azeri, the dot of i in Lithuanian and the accents of capitals in Greek. The functions ask ICU for
// the root locale. Each word below has a character above U+00FF, so that ICU maps it and not a table.
describe.skipIf(isWindows)("the locale of the system", () => {
  test.concurrent.each(["tr_TR.UTF-8", "az_AZ.UTF-8", "lt_LT.UTF-8", "el_GR.UTF-8"])(
    "LC_ALL=%s changes no result",
    async locale => {
      const script = `console.log(JSON.stringify([
        Bun.snakeCase("TITLE\\u03a9"),
        Bun.constantCase("i\\u03c9"),
        Bun.capitalCase("XI\\u03a9"),
        Bun.snakeCase("\\u00cc\\u03a9"),
        Bun.constantCase("\\u03ac\\u03bb\\u03c6\\u03b1"),
      ]))`;
      await using proc = Bun.spawn({
        cmd: [bunExe(), "-e", script],
        env: { ...bunEnv, LANG: undefined, LC_MESSAGES: undefined, LC_ALL: locale },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect({ stdout: stdout.trim(), stderr, exitCode }).toEqual({
        stdout: JSON.stringify(["title\u03c9", "I\u03a9", "Xi\u03c9", "\u00ec\u03c9", "\u0386\u039b\u03a6\u0391"]),
        stderr: "",
        exitCode: 0,
      });
    },
  );
});

describe("strings", () => {
  test("a rope and a substring", () => {
    const parts = ["foo", "Bar", "_baz", "QUX1"];
    let rope = "";
    for (const part of parts) rope += part;
    expect(isRope(rope)).toBe(true);
    expect(Bun.kebabCase(rope)).toBe("foo-bar-baz-qux1");

    let wideRope = "";
    for (const part of ["σοφός", "Σοφός", "_日本", "Text"]) wideRope += part;
    expect(isRope(wideRope)).toBe(true);
    expect(Bun.snakeCase(wideRope)).toBe("σοφός_σοφός_日本text");

    const text = "the quick brownFox jumpsOver the lazy dog";
    expect(Bun.constantCase(text.slice(10, 28))).toBe("BROWN_FOX_JUMPS_OVER");
    expect(Bun.constantCase(wide(text).slice(10, 28))).toBe("BROWN_FOX_JUMPS_OVER");
  });

  test("the result is 8-bit when its text is Latin-1", () => {
    expect(is8Bit(Bun.snakeCase("fooBar"))).toBe(true);
    expect(is8Bit(Bun.constantCase("straßeBahn"))).toBe(true);

    // From a 16-bit input too.
    const input = wide("straßeBahn");
    expect(is8Bit(input)).toBe(false);
    expect(Bun.constantCase(input)).toBe("STRASSE_BAHN");
    expect(is8Bit(Bun.constantCase(input))).toBe(true);
    // U+212A KELVIN SIGN and U+0178 are not Latin-1, and their lowercase is.
    expect(Bun.snakeCase("\u212aelvin \u0178es")).toBe("kelvin_ÿes");
    expect(is8Bit(Bun.snakeCase("\u212aelvin \u0178es"))).toBe(true);

    // 16-bit where the text is not Latin-1: the uppercase of U+00B5 and of U+00FF, and other scripts.
    expect(Bun.capitalCase("µm")).toBe("\u039cm");
    expect(is8Bit(Bun.capitalCase("µm"))).toBe(false);
    expect(Bun.constantCase("ÿes")).toBe("\u0178ES");
    expect(is8Bit(Bun.constantCase("ÿes"))).toBe(false);
    expect(is8Bit(Bun.snakeCase("日本語Text"))).toBe(false);
  });

  test("a result that is the input is not a new string", async () => {
    // The count of string cells in a process of its own. 10,000 results that are kept add no cell when each one is
    // its input, and 10,000 cells when each one is new. The inputs are made flat first: a rope lets go of its
    // parts when it is read, and that would hide new cells.
    const script = `
      const { heapStats } = require("bun:jsc");
      const narrow = input => Buffer.from(input, "latin1").toString("latin1");
      const wide = input => Buffer.from(input, "utf16le").toString("utf16le");
      const strings = () => {
        Bun.gc(true);
        return heapStats().objectTypeCounts.string;
      };
      const added = (inputs, convert) => {
        const before = strings();
        const results = inputs.map(input => convert(input));
        const count = strings() - before;
        if (results.length !== inputs.length) throw new Error("unreachable");
        return count;
      };
      const snake = [], camel = [], greek = [];
      for (let i = 0; i < 10000; i++) {
        snake.push(narrow("created_at_" + i));
        camel.push(narrow("createdAt" + i));
        greek.push(wide("δημιουργήθηκε_" + i));
      }
      console.log(JSON.stringify({
        same8Bit: added(snake, Bun.snakeCase),
        same16Bit: added(greek, Bun.snakeCase),
        changed: added(camel, Bun.snakeCase),
      }));
    `;
    await using proc = Bun.spawn({ cmd: [bunExe(), "-e", script], env: bunEnv, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stderr).toBe("");
    const { same8Bit, same16Bit, changed } = JSON.parse(stdout);
    expect(Math.abs(same8Bit)).toBeLessThan(100);
    expect(Math.abs(same16Bit)).toBeLessThan(100);
    expect(changed).toBeGreaterThan(9900);
    expect(exitCode).toBe(0);
  });

  test("a result over the string length limit throws", () => {
    // 400,000 times "aB" is 400,001 words: a result of 1.2 million characters.
    const latin1 = Buffer.alloc(800_000, "aB").toString("latin1");
    const utf16 = wide(latin1);
    const micro = Buffer.alloc(1_200_000, "µ", "latin1").toString("latin1");
    const lower = Buffer.alloc(1_200_000, "a").toString("latin1");
    expect(is8Bit(latin1)).toBe(true);
    expect(is8Bit(utf16)).toBe(false);
    const originalLimit = setSyntheticAllocationLimitForTesting(1024 * 1024);
    try {
      expect(() => Bun.snakeCase(latin1)).toThrow("Out of memory");
      expect(() => Bun.snakeCase(utf16)).toThrow("Out of memory");
      // An 8-bit input with a 16-bit result.
      expect(() => Bun.constantCase(micro)).toThrow("Out of memory");
      // No string is made for a result that is the input.
      expect(Bun.snakeCase(lower)).toBe(lower);
    } finally {
      setSyntheticAllocationLimitForTesting(originalLimit);
    }
    expect(Bun.snakeCase(latin1).length).toBe(1_200_000);
    expect(Bun.snakeCase(utf16).length).toBe(1_200_000);
    expect(Bun.constantCase(micro).length).toBe(1_200_000);
  });

  test("the longest result is the limit of a string, or half of it for a 16-bit input", () => {
    const limit = 1024 * 1024;
    const half = limit / 2;
    const narrow = (text: string, count: number) => Buffer.alloc(count, text, "latin1").toString("latin1");
    const wideOf = (text: string, count: number) => Buffer.alloc(count * 2, text, "utf16le").toString("utf16le");
    // [function, input, the length of its result]. Every pair is one unit under and one unit over a limit.
    const cases: [Name, string, number][] = [
      // An 8-bit input with an 8-bit result, and with a 16-bit result.
      ["snakeCase", narrow("A", limit), limit],
      ["snakeCase", narrow("A", limit + 1), limit + 1],
      ["constantCase", narrow("µ", limit), limit],
      ["constantCase", narrow("µ", limit + 1), limit + 1],
      // A 16-bit input of Latin-1 text, which the tables map.
      ["snakeCase", wideOf("A", half), half],
      ["snakeCase", wideOf("A", half + 1), half + 1],
      // One Greek word, which ICU maps in one call.
      ["snakeCase", wideOf("Α", half), half],
      ["snakeCase", wideOf("Α", half + 1), half + 1],
      // U+0390 is three units in uppercase: ICU asks for a longer buffer, and that one is over the limit or not.
      ["constantCase", wideOf("ΐ", 174_762), 524_286],
      ["constantCase", wideOf("ΐ", 174_763), 524_289],
      // Words after the one that did not fit.
      ["constantCase", wideOf("ΐ", 174_763) + " Αβ Γδ Εζ", 524_298],
      // A result that is the input is not copied for an 8-bit input. A 16-bit input goes through the buffer.
      ["snakeCase", narrow("a", limit + 1), limit + 1],
      ["snakeCase", wideOf("a", half), half],
      ["snakeCase", wideOf("a", half + 1), half + 1],
    ];
    const run = ([name, input]: [Name, string, number]) => {
      try {
        return Bun[name](input).length;
      } catch (error) {
        return (error as Error).message;
      }
    };
    const originalLimit = setSyntheticAllocationLimitForTesting(limit);
    let limited: (number | string)[];
    try {
      limited = cases.map(run);
    } finally {
      setSyntheticAllocationLimitForTesting(originalLimit);
    }
    const outOfMemory = "Out of memory";
    expect(limited).toEqual([
      limit,
      outOfMemory,
      limit,
      outOfMemory,
      half,
      outOfMemory,
      half,
      outOfMemory,
      524_286,
      outOfMemory,
      outOfMemory,
      limit + 1,
      half,
      outOfMemory,
    ]);
    // Without the limit each call gives the length that the table says.
    expect(cases.map(run)).toEqual(cases.map(([, , length]) => length));
  });
});
