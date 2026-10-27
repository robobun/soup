//! The arithmetic of `$(( ))`.
//!
//! The grammar, the precedence of the operators and the messages are those of bash (`expr.c`):
//! the integer operators of C on 64-bit signed integers that wrap, and `**`.
//!
//! An expression is evaluated while it is read, so there is no tree. An operand that C would not
//! evaluate (the right side of `0 && x`, the arm of `?:` that is not taken) is read with `noeval`
//! set: it assigns nothing, reads no variable and cannot divide by zero. A syntax error, a bad
//! number and a negative exponent in it are still errors, as in bash.
//!
//! Where this leaves bash: a name is a shell variable whose value has to be an integer, and is
//! not read as an expression of its own (dash does the same). What `$name`, `$(command)` or an
//! interpolated value adds to an expression has to be a number too, see [`operand`]. So data is
//! never an operator, an assignment or the name of a variable.

#![forbid(unsafe_code)]

use bun_core::StackCheck;

/// The shell variables that an expression reads and assigns.
pub trait Variables {
    /// The value of `name`, or `None` when it is not set.
    fn get(&self, name: &[u8]) -> Option<Vec<u8>>;
    fn set(&mut self, name: &[u8], value: i64);
}

/// Why an expression has no value.
#[derive(Debug)]
pub struct Error {
    /// The expression, which is the value of a variable when the error is in one.
    expression: Box<[u8]>,
    message: &'static str,
    /// The expression from the token that the error is at.
    token: Box<[u8]>,
}

impl Error {
    /// The message as bash prints it: `1/0: division by 0 (error token is "0")`.
    pub fn message(&self) -> Vec<u8> {
        let mut out =
            Vec::with_capacity(self.expression.len() + self.message.len() + self.token.len() + 24);
        out.extend_from_slice(&self.expression);
        out.extend_from_slice(b": ");
        out.extend_from_slice(self.message.as_bytes());
        out.extend_from_slice(b" (error token is \"");
        out.extend_from_slice(&self.token);
        out.extend_from_slice(b"\")");
        out
    }
}

/// What is not a number where data has to be one: the value of a variable, or what an expansion
/// adds to an expression.
pub fn not_an_integer(text: &[u8]) -> Error {
    let text = trim(text);
    Error {
        expression: text.into(),
        message: "not an integer",
        token: text.into(),
    }
}

/// How deep parentheses, unary operators, `**`, `?:` and assignments nest in total. Each is a
/// recursion of the evaluator.
const MAX_DEPTH: u32 = 128;

/// The value of `expression`. An expression of only whitespace is 0.
pub fn evaluate(expression: &[u8], variables: &mut dyn Variables) -> Result<i64, Error> {
    Evaluator::run(expression, variables)
}

/// What an expansion (`$name`, `$(command)`, an interpolated value) adds to an expression.
pub enum Operand<'a> {
    /// Nothing: the expansion is empty.
    Empty,
    /// An integer, or the rest of the number or the name that the text before it starts, as in
    /// `10#$month` and `0x$hex`.
    Text(&'a [u8]),
    /// An integer with a sign. It goes in parentheses, so that `x-$n` is never `x--1`.
    Signed(&'a [u8]),
}

/// An expansion is data, so it is a number in an expression and never an operator, an assignment
/// or a name of its own. `continues` says that the byte before it is part of a name or a number.
pub fn operand(text: &[u8], continues: bool) -> Result<Operand<'_>, Error> {
    let text = trim(text);
    let (signed, digits) = match text.split_first() {
        None => return Ok(Operand::Empty),
        Some((b'-' | b'+', digits)) => (true, digits),
        Some(_) => (false, text),
    };
    let starts_a_number = digits.first().is_some_and(u8::is_ascii_digit);
    if !digits.iter().all(|&c| is_number_char(c)) || !(starts_a_number || (continues && !signed)) {
        return Err(not_an_integer(text));
    }
    Ok(if signed {
        Operand::Signed(text)
    } else {
        Operand::Text(text)
    })
}

/// Whether `text` is one integer, with a sign or without.
pub fn is_integer(text: &[u8]) -> bool {
    !trim(text).is_empty() && constant(text).is_ok()
}

/// The integer that the value of a variable is. An empty value is 0.
fn constant(text: &[u8]) -> Result<i64, Error> {
    let text = trim(text);
    let (negative, digits) = match text.split_first() {
        None => return Ok(0),
        Some((b'-', digits)) => (true, digits),
        Some((b'+', digits)) => (false, digits),
        Some(_) => (false, text),
    };
    if !digits.first().is_some_and(u8::is_ascii_digit) || !digits.iter().all(|&c| is_number_char(c))
    {
        return Err(not_an_integer(text));
    }
    match parse_number(digits) {
        Ok(value) if negative => Ok(value.wrapping_neg()),
        Ok(value) => Ok(value),
        Err(message) => Err(Error {
            expression: text.into(),
            message,
            token: digits.into(),
        }),
    }
}

fn trim(mut text: &[u8]) -> &[u8] {
    while let Some((&first, rest)) = text.split_first()
        && is_blank(first)
    {
        text = rest;
    }
    while let Some((&last, rest)) = text.split_last()
        && is_blank(last)
    {
        text = rest;
    }
    text
}

/// `10`, `010` (octal), `0x10`, and `base#digits` for a base from 2 to 64, where the digits
/// after `9` are `a` to `z`, `A` to `Z`, `@` and `_`. Up to base 36 a letter is the same digit in
/// both cases. `num` starts with a digit and has only the characters of a number.
fn parse_number(num: &[u8]) -> Result<i64, &'static str> {
    let mut s = 0;
    let mut base: i64 = 10;
    let mut found_base = false;
    if num[0] == b'0' {
        s = 1;
        match num.get(s) {
            None => return Ok(0),
            Some(b'x' | b'X') => {
                base = 16;
                s += 1;
            }
            Some(_) => base = 8,
        }
        found_base = true;
    }

    let mut value: i64 = 0;
    while let Some(&c) = num.get(s) {
        s += 1;
        if c == b'#' {
            if found_base {
                return Err("invalid number");
            }
            if !(2..=64).contains(&value) {
                return Err("invalid arithmetic base");
            }
            base = value;
            value = 0;
            found_base = true;
            if !num
                .get(s)
                .is_some_and(|&next| is_number_char(next) && next != b'#')
            {
                return Err("invalid integer constant");
            }
            continue;
        }
        let digit = match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'z' => c - b'a' + 10,
            b'A'..=b'Z' => c - b'A' + if base <= 36 { 10 } else { 36 },
            b'@' => 62,
            _ => 63,
        };
        if i64::from(digit) >= base {
            return Err("value too great for base");
        }
        value = value.wrapping_mul(base).wrapping_add(i64::from(digit));
    }
    Ok(value)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Token {
    End,
    Num,
    /// A name.
    Str,
    Eq,
    Gt,
    Lt,
    Plus,
    Minus,
    Mul,
    Div,
    Mod,
    Not,
    LPar,
    RPar,
    BAnd,
    BOr,
    BXor,
    BNot,
    Ques,
    Col,
    Comma,
    EqEq,
    Neq,
    Leq,
    Geq,
    LAnd,
    LOr,
    Lsh,
    Rsh,
    /// `+=` and the other nine.
    OpAssign(AssignOp),
    Power,
    PreInc,
    PreDec,
    PostInc,
    PostDec,
    /// What `lasttok` is after a `?:`. `readtok` never returns it.
    Cond,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AssignOp {
    Mul,
    Div,
    Mod,
    Plus,
    Minus,
    Lsh,
    Rsh,
    BAnd,
    BXor,
    BOr,
}

impl AssignOp {
    fn from_byte(c: u8) -> Option<AssignOp> {
        Some(match c {
            b'*' => AssignOp::Mul,
            b'/' => AssignOp::Div,
            b'%' => AssignOp::Mod,
            b'+' => AssignOp::Plus,
            b'-' => AssignOp::Minus,
            b'&' => AssignOp::BAnd,
            b'^' => AssignOp::BXor,
            b'|' => AssignOp::BOr,
            _ => return None,
        })
    }

    /// `rhs` is not 0 for `Div` and `Mod`.
    fn apply(self, lhs: i64, rhs: i64) -> i64 {
        match self {
            AssignOp::Mul => lhs.wrapping_mul(rhs),
            AssignOp::Div => divide(lhs, rhs),
            AssignOp::Mod => remainder(lhs, rhs),
            AssignOp::Plus => lhs.wrapping_add(rhs),
            AssignOp::Minus => lhs.wrapping_sub(rhs),
            AssignOp::Lsh => shift_left(lhs, rhs),
            AssignOp::Rsh => shift_right(lhs, rhs),
            AssignOp::BAnd => lhs & rhs,
            AssignOp::BXor => lhs ^ rhs,
            AssignOp::BOr => lhs | rhs,
        }
    }
}

/// `i64::MIN / -1` does not fit. bash gives `i64::MIN`, and 0 for the remainder.
fn divide(lhs: i64, rhs: i64) -> i64 {
    lhs.wrapping_div(rhs)
}

fn remainder(lhs: i64, rhs: i64) -> i64 {
    lhs.wrapping_rem(rhs)
}

/// A count of 64 or more, or below 0, is undefined in C. This is what x86-64 and arm64 do with it,
/// and so what bash prints there: the count modulo 64.
fn shift_left(lhs: i64, rhs: i64) -> i64 {
    lhs.wrapping_shl(rhs as u32)
}

fn shift_right(lhs: i64, rhs: i64) -> i64 {
    lhs.wrapping_shr(rhs as u32)
}

fn power(mut base: i64, mut exponent: i64) -> i64 {
    let mut result: i64 = 1;
    while exponent != 0 {
        if (exponent & 1) != 0 {
            result = result.wrapping_mul(base);
        }
        exponent >>= 1;
        base = base.wrapping_mul(base);
    }
    result
}

/// bash does not count `\r`. It is a blank here, for a script with CRLF line ends.
fn is_blank(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r')
}

fn is_name_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}

fn is_name_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// The characters of a number: `0x1F`, `2#101`, `64#@_`. A name has no others.
pub fn is_number_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'#' | b'@' | b'_')
}

/// A name as a range of the expression.
type Name = (usize, usize);

/// What a token that is read ahead of its turn must not change.
#[derive(Clone, Copy)]
struct Saved {
    tp: usize,
    lasttp: usize,
    curtok: Token,
    lasttok: Token,
    tokval: i64,
    tokstr: Option<Name>,
}

struct Evaluator<'a> {
    expression: &'a [u8],
    variables: &'a mut dyn Variables,
    /// Where the next token starts.
    tp: usize,
    /// Where the last token started. An error quotes the expression from here.
    lasttp: usize,
    curtok: Token,
    lasttok: Token,
    /// The value of a `Num`, and of a `Str` that was read as a variable.
    tokval: i64,
    /// The name of the last `Str`. An assignment takes it.
    tokstr: Option<Name>,
    /// Above 0 in an operand that is read and not evaluated.
    noeval: u32,
    /// The token is read ahead of its turn, to see what follows a name. A name is then only a
    /// `Str`: its variable is not read.
    peeking: bool,
    depth: u32,
    stack_check: StackCheck,
}

impl<'a> Evaluator<'a> {
    fn run(expression: &'a [u8], variables: &'a mut dyn Variables) -> Result<i64, Error> {
        if expression.iter().all(|&c| is_blank(c)) {
            return Ok(0);
        }
        let mut this = Evaluator {
            expression,
            variables,
            tp: 0,
            lasttp: 0,
            curtok: Token::End,
            lasttok: Token::End,
            tokval: 0,
            tokstr: None,
            noeval: 0,
            peeking: false,
            depth: 0,
            stack_check: StackCheck::init(),
        };
        this.readtok()?;
        let value = this.expcomma()?;
        if this.curtok != Token::End {
            return Err(this.error("syntax error in expression"));
        }
        Ok(value)
    }

    fn error(&self, message: &'static str) -> Error {
        self.error_before(self.expression.len(), message)
    }

    /// An error that quotes the expression up to `end` and no further.
    fn error_before(&self, end: usize, message: &'static str) -> Error {
        let expression = &self.expression[..end];
        let start = expression
            .iter()
            .position(|&c| !matches!(c, b' ' | b'\t'))
            .unwrap_or(end);
        Error {
            expression: expression[start..].into(),
            message,
            token: expression[self.lasttp.min(end)..].into(),
        }
    }

    fn enter(&mut self) -> Result<(), Error> {
        if self.depth >= MAX_DEPTH || !self.stack_check.is_safe_to_recurse() {
            return Err(self.error("expression recursion level exceeded"));
        }
        self.depth += 1;
        Ok(())
    }

    fn leave(&mut self) {
        self.depth -= 1;
    }

    fn save(&self) -> Saved {
        Saved {
            tp: self.tp,
            lasttp: self.lasttp,
            curtok: self.curtok,
            lasttok: self.lasttok,
            tokval: self.tokval,
            tokstr: self.tokstr,
        }
    }

    fn restore(&mut self, saved: Saved) {
        self.tp = saved.tp;
        self.lasttp = saved.lasttp;
        self.curtok = saved.curtok;
        self.lasttok = saved.lasttok;
        self.tokval = saved.tokval;
        self.tokstr = saved.tokstr;
    }

    /// Reads the next token without the variable of a name. `restore` undoes it.
    fn readtok_ahead(&mut self) -> Result<(), Error> {
        self.peeking = true;
        let result = self.readtok();
        self.peeking = false;
        result
    }

    fn name(&self, name: Name) -> &'a [u8] {
        &self.expression[name.0..name.1]
    }

    /// The value of a variable. One that is not set is 0.
    fn variable(&mut self, name: Name) -> Result<i64, Error> {
        if self.noeval != 0 {
            return Ok(0);
        }
        match self.variables.get(self.name(name)) {
            Some(value) => constant(&value),
            None => Ok(0),
        }
    }

    fn assign(&mut self, name: Name, value: i64) {
        if self.noeval == 0 {
            self.variables.set(self.name(name), value);
        }
    }

    fn readtok(&mut self) -> Result<(), Error> {
        let e = self.expression;
        let mut cp = self.tp;
        while cp < e.len() && is_blank(e[cp]) {
            cp += 1;
        }
        let Some(&c) = e.get(cp) else {
            // `lasttp` stays at the last token: `1 +` is an error at the `+`.
            self.lasttok = self.curtok;
            self.curtok = Token::End;
            self.tp = cp;
            return Ok(());
        };
        self.tp = cp;
        self.lasttp = cp;
        cp += 1;

        if is_name_start(c) {
            while cp < e.len() && is_name_char(e[cp]) {
                cp += 1;
            }
            let name: Name = (self.tp, cp);
            if self.peeking {
                // bash reads on through a run of names before it reads the variable of the
                // first, so an error in the token after the run comes first: `a b 08`.
                loop {
                    while cp < e.len() && is_blank(e[cp]) {
                        cp += 1;
                    }
                    if !e.get(cp).is_some_and(|&next| is_name_start(next)) {
                        break;
                    }
                    while cp < e.len() && is_name_char(e[cp]) {
                        cp += 1;
                    }
                }
                self.tp = cp;
                self.curtok = Token::Str;
                self.readtok()?;
                self.curtok = Token::Str;
                return Ok(());
            }

            // The name of `name = value` is not read as a variable, so what it holds is not
            // evaluated: `x=1` assigns whatever `x` was.
            let saved = self.save();
            self.tp = cp;
            self.curtok = Token::Str;
            let result = self.readtok_ahead();
            let peektok = self.curtok;
            self.restore(saved);
            result?;

            self.tokstr = Some(name);
            self.tokval =
                if matches!(self.lasttok, Token::PreInc | Token::PreDec) || peektok != Token::Eq {
                    self.variable(name)?
                } else {
                    0
                };
            self.lasttok = self.curtok;
            self.curtok = Token::Str;
        } else if c.is_ascii_digit() {
            while cp < e.len() && is_number_char(e[cp]) {
                cp += 1;
            }
            self.tokval = self.strlong(cp)?;
            self.lasttok = self.curtok;
            self.curtok = Token::Num;
        } else {
            let c1 = e.get(cp).copied();
            cp += 1;
            let token = if c == b'=' && c1 == Some(b'=') {
                Token::EqEq
            } else if c == b'!' && c1 == Some(b'=') {
                Token::Neq
            } else if c == b'>' && c1 == Some(b'=') {
                Token::Geq
            } else if c == b'<' && c1 == Some(b'=') {
                Token::Leq
            } else if c == b'<' && c1 == Some(b'<') {
                if e.get(cp) == Some(&b'=') {
                    cp += 1;
                    Token::OpAssign(AssignOp::Lsh)
                } else {
                    Token::Lsh
                }
            } else if c == b'>' && c1 == Some(b'>') {
                if e.get(cp) == Some(&b'=') {
                    cp += 1;
                    Token::OpAssign(AssignOp::Rsh)
                } else {
                    Token::Rsh
                }
            } else if c == b'&' && c1 == Some(b'&') {
                Token::LAnd
            } else if c == b'|' && c1 == Some(b'|') {
                Token::LOr
            } else if c == b'*' && c1 == Some(b'*') {
                Token::Power
            } else if (c == b'-' || c == b'+') && c1 == Some(c) && self.curtok == Token::Str {
                if c == b'-' {
                    Token::PostDec
                } else {
                    Token::PostInc
                }
            } else if (c == b'-' || c == b'+')
                && c1 == Some(c)
                && self.curtok == Token::Num
                && matches!(self.lasttok, Token::PreInc | Token::PreDec)
            {
                // `--x++`
                return Err(self.error(if c == b'-' {
                    "--: assignment requires lvalue"
                } else {
                    "++: assignment requires lvalue"
                }));
            } else if (c == b'-' || c == b'+') && c1 == Some(c) {
                // `++` before a name increments it. Before anything else it is two signs.
                let mut xp = cp;
                while xp < e.len() && is_blank(e[xp]) {
                    xp += 1;
                }
                if e.get(xp).is_some_and(|&next| is_name_start(next)) {
                    if c == b'-' {
                        Token::PreDec
                    } else {
                        Token::PreInc
                    }
                } else {
                    cp -= 1;
                    if c == b'-' { Token::Minus } else { Token::Plus }
                }
            } else if let (Some(b'='), Some(op)) = (c1, AssignOp::from_byte(c)) {
                Token::OpAssign(op)
            } else {
                cp -= 1;
                match c {
                    b'=' => Token::Eq,
                    b'>' => Token::Gt,
                    b'<' => Token::Lt,
                    b'+' => Token::Plus,
                    b'-' => Token::Minus,
                    b'*' => Token::Mul,
                    b'/' => Token::Div,
                    b'%' => Token::Mod,
                    b'!' => Token::Not,
                    b'(' => Token::LPar,
                    b')' => Token::RPar,
                    b'&' => Token::BAnd,
                    b'|' => Token::BOr,
                    b'^' => Token::BXor,
                    b'~' => Token::BNot,
                    b'?' => Token::Ques,
                    b':' => Token::Col,
                    b',' => Token::Comma,
                    _ => {
                        // After an operand, this is where an operator goes.
                        return Err(self.error(
                            if matches!(self.curtok, Token::Num | Token::Str) {
                                "syntax error: invalid arithmetic operator"
                            } else {
                                "syntax error: operand expected"
                            },
                        ));
                    }
                }
            };
            self.lasttok = self.curtok;
            self.curtok = token;
        }
        self.tp = cp;
        Ok(())
    }

    /// The number from `tp` to `end`. An error in it quotes the expression up to the end of the
    /// number and no further, as bash does.
    fn strlong(&self, end: usize) -> Result<i64, Error> {
        parse_number(&self.expression[self.tp..end])
            .map_err(|message| self.error_before(end, message))
    }

    fn expcomma(&mut self) -> Result<i64, Error> {
        let mut value = self.expassign()?;
        while self.curtok == Token::Comma {
            self.readtok()?;
            value = self.expassign()?;
        }
        Ok(value)
    }

    fn expassign(&mut self) -> Result<i64, Error> {
        let lvalue = self.expcond()?;
        let op = match self.curtok {
            Token::Eq => None,
            Token::OpAssign(op) => Some(op),
            _ => return Ok(lvalue),
        };
        if self.lasttok != Token::Str {
            return Err(self.error("attempted assignment to non-variable"));
        }
        let Some(name) = self.tokstr else {
            return Err(self.error("syntax error in variable assignment"));
        };
        self.readtok()?;
        self.enter()?;
        let mut value = self.expassign()?;
        self.leave();

        if let Some(op) = op {
            if matches!(op, AssignOp::Div | AssignOp::Mod) && value == 0 {
                if self.noeval == 0 {
                    return Err(self.error("division by 0"));
                }
                value = 1;
            }
            value = op.apply(lvalue, value);
        }
        self.assign(name, value);
        self.tokstr = None;
        Ok(value)
    }

    fn expcond(&mut self) -> Result<i64, Error> {
        let condition = self.explor()?;
        if self.curtok != Token::Ques {
            return Ok(condition);
        }
        self.enter()?;

        if condition == 0 {
            self.noeval += 1;
        }
        self.readtok()?;
        if matches!(self.curtok, Token::End | Token::Col) {
            return Err(self.error("expression expected"));
        }
        let if_true = self.expcomma()?;
        if condition == 0 {
            self.noeval -= 1;
        }
        if self.curtok != Token::Col {
            return Err(self.error("`:' expected for conditional expression"));
        }

        if condition != 0 {
            self.noeval += 1;
        }
        self.readtok()?;
        if self.curtok == Token::End {
            return Err(self.error("expression expected"));
        }
        let if_false = self.expcond()?;
        if condition != 0 {
            self.noeval -= 1;
        }

        self.leave();
        self.lasttok = Token::Cond;
        Ok(if condition != 0 { if_true } else { if_false })
    }

    fn explor(&mut self) -> Result<i64, Error> {
        let mut val1 = self.expland()?;
        while self.curtok == Token::LOr {
            let skip = val1 != 0;
            if skip {
                self.noeval += 1;
            }
            self.readtok()?;
            let val2 = self.expland()?;
            if skip {
                self.noeval -= 1;
            }
            val1 = i64::from(val1 != 0 || val2 != 0);
            self.lasttok = Token::LOr;
        }
        Ok(val1)
    }

    fn expland(&mut self) -> Result<i64, Error> {
        let mut val1 = self.expbor()?;
        while self.curtok == Token::LAnd {
            let skip = val1 == 0;
            if skip {
                self.noeval += 1;
            }
            self.readtok()?;
            let val2 = self.expbor()?;
            if skip {
                self.noeval -= 1;
            }
            val1 = i64::from(val1 != 0 && val2 != 0);
            self.lasttok = Token::LAnd;
        }
        Ok(val1)
    }

    fn expbor(&mut self) -> Result<i64, Error> {
        let mut val1 = self.expbxor()?;
        while self.curtok == Token::BOr {
            self.readtok()?;
            val1 |= self.expbxor()?;
            self.lasttok = Token::Num;
        }
        Ok(val1)
    }

    fn expbxor(&mut self) -> Result<i64, Error> {
        let mut val1 = self.expband()?;
        while self.curtok == Token::BXor {
            self.readtok()?;
            val1 ^= self.expband()?;
            self.lasttok = Token::Num;
        }
        Ok(val1)
    }

    fn expband(&mut self) -> Result<i64, Error> {
        let mut val1 = self.expequal()?;
        while self.curtok == Token::BAnd {
            self.readtok()?;
            val1 &= self.expequal()?;
            self.lasttok = Token::Num;
        }
        Ok(val1)
    }

    fn expequal(&mut self) -> Result<i64, Error> {
        let mut val1 = self.expcompare()?;
        while matches!(self.curtok, Token::EqEq | Token::Neq) {
            let op = self.curtok;
            self.readtok()?;
            let val2 = self.expcompare()?;
            val1 = i64::from(if op == Token::EqEq {
                val1 == val2
            } else {
                val1 != val2
            });
            self.lasttok = Token::Num;
        }
        Ok(val1)
    }

    fn expcompare(&mut self) -> Result<i64, Error> {
        let mut val1 = self.expshift()?;
        while matches!(self.curtok, Token::Leq | Token::Geq | Token::Lt | Token::Gt) {
            let op = self.curtok;
            self.readtok()?;
            let val2 = self.expshift()?;
            val1 = i64::from(match op {
                Token::Leq => val1 <= val2,
                Token::Geq => val1 >= val2,
                Token::Lt => val1 < val2,
                _ => val1 > val2,
            });
            self.lasttok = Token::Num;
        }
        Ok(val1)
    }

    fn expshift(&mut self) -> Result<i64, Error> {
        let mut val1 = self.expadd()?;
        while matches!(self.curtok, Token::Lsh | Token::Rsh) {
            let op = self.curtok;
            self.readtok()?;
            let val2 = self.expadd()?;
            val1 = if op == Token::Lsh {
                shift_left(val1, val2)
            } else {
                shift_right(val1, val2)
            };
            self.lasttok = Token::Num;
        }
        Ok(val1)
    }

    fn expadd(&mut self) -> Result<i64, Error> {
        let mut val1 = self.expmuldiv()?;
        while matches!(self.curtok, Token::Plus | Token::Minus) {
            let op = self.curtok;
            self.readtok()?;
            let val2 = self.expmuldiv()?;
            val1 = if op == Token::Plus {
                val1.wrapping_add(val2)
            } else {
                val1.wrapping_sub(val2)
            };
            self.lasttok = Token::Num;
        }
        Ok(val1)
    }

    fn expmuldiv(&mut self) -> Result<i64, Error> {
        let mut val1 = self.exppower()?;
        while matches!(self.curtok, Token::Mul | Token::Div | Token::Mod) {
            let op = self.curtok;
            let after_operator = self.tp;
            self.readtok()?;
            let mut val2 = self.exppower()?;
            if op != Token::Mul && val2 == 0 {
                if self.noeval == 0 {
                    // The error is at the divisor, not at what follows it.
                    self.lasttp = after_operator;
                    while matches!(self.expression.get(self.lasttp), Some(b' ' | b'\t')) {
                        self.lasttp += 1;
                    }
                    return Err(self.error("division by 0"));
                }
                val2 = 1;
            }
            val1 = match op {
                Token::Mul => val1.wrapping_mul(val2),
                Token::Div => divide(val1, val2),
                _ => remainder(val1, val2),
            };
            // bash skips this for `i64::MIN % -1`, and so takes `x % y = 1` for an assignment.
            self.lasttok = Token::Num;
        }
        Ok(val1)
    }

    /// `**` groups from the right, and binds less than a sign: `-2 ** 2` is 4.
    fn exppower(&mut self) -> Result<i64, Error> {
        let mut val1 = self.expunary()?;
        while self.curtok == Token::Power {
            self.readtok()?;
            self.enter()?;
            let val2 = self.exppower()?;
            self.leave();
            self.lasttok = Token::Num;
            if val2 == 0 {
                return Ok(1);
            }
            if val2 < 0 {
                return Err(self.error("exponent less than 0"));
            }
            val1 = power(val1, val2);
        }
        Ok(val1)
    }

    fn expunary(&mut self) -> Result<i64, Error> {
        let op = self.curtok;
        if !matches!(op, Token::Not | Token::BNot | Token::Minus | Token::Plus) {
            return self.expprimary();
        }
        self.readtok()?;
        self.enter()?;
        let value = self.expunary()?;
        self.leave();
        self.lasttok = Token::Num;
        Ok(match op {
            Token::Not => i64::from(value == 0),
            Token::BNot => !value,
            Token::Minus => value.wrapping_neg(),
            _ => value,
        })
    }

    fn expprimary(&mut self) -> Result<i64, Error> {
        match self.curtok {
            Token::PreInc | Token::PreDec => {
                let op = self.curtok;
                // A name after `++` is read as a variable even before an `=`.
                self.lasttok = op;
                self.readtok()?;
                let Some(name) = self.tokstr.filter(|_| self.curtok == Token::Str) else {
                    return Err(
                        self.error("identifier expected after pre-increment or pre-decrement")
                    );
                };
                let value = self
                    .tokval
                    .wrapping_add(if op == Token::PreInc { 1 } else { -1 });
                self.assign(name, value);
                // Not a `Str`, so that `--x=7` is an error.
                self.curtok = Token::Num;
                self.readtok()?;
                Ok(value)
            }
            Token::LPar => {
                self.readtok()?;
                self.enter()?;
                let value = self.expcomma()?;
                self.leave();
                if self.curtok != Token::RPar {
                    return Err(self.error("missing `)'"));
                }
                self.readtok()?;
                Ok(value)
            }
            Token::Num => {
                let value = self.tokval;
                self.readtok()?;
                Ok(value)
            }
            Token::Str => {
                let value = self.tokval;
                let name = self.tokstr;
                let saved = self.save();
                self.readtok_ahead()?;
                match (self.curtok, name) {
                    (op @ (Token::PostInc | Token::PostDec), Some(name)) => {
                        self.tokstr = Some(name);
                        self.lasttok = Token::Str;
                        self.assign(
                            name,
                            value.wrapping_add(if op == Token::PostInc { 1 } else { -1 }),
                        );
                        // Not a `Str`, so that `x++=7` is an error.
                        self.curtok = Token::Num;
                    }
                    _ => self.restore(saved),
                }
                self.readtok()?;
                Ok(value)
            }
            _ => Err(self.error("syntax error: operand expected")),
        }
    }
}
