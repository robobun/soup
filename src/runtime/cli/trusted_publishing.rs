//! npm trusted publishing for `bun publish`.
//!
//! A CI job proves who it is with an OIDC id token. The registry checks the
//! token against the trusted publisher that is configured for the package and
//! answers with a token that can publish that package for a short time, so the
//! job stores no npm token.
//!
//! The registry's side: https://docs.npmjs.com/trusted-publishers
//! The npm CLI's client: https://github.com/npm/cli/blob/latest/lib/utils/oidc.js

use std::io::Write as _;

use bun_alloc::AllocError;
use bun_core::fmt as bun_fmt;
use bun_core::{MutableString, env_var, strings};
use bun_http as http;
use bun_install::Npm;
use bun_parsers::json as json_mod;
use bun_url::URL;

pub(crate) enum Exchange {
    /// The environment offers no id token. Nothing was sent.
    NotOffered,
    /// The registry issued this publish token.
    Token(Box<[u8]>),
    /// An id token was on offer and no publish token came of it. Holds a
    /// sentence for the user that names the step that failed.
    Failed(Box<[u8]>),
}

/// Trades the OIDC id token of this CI job for a token that can publish
/// `package_name` to `registry`.
pub(crate) fn exchange(
    registry: &Npm::Registry::Scope,
    package_name: &[u8],
) -> Result<Exchange, AllocError> {
    let id_token = match id_token(registry)? {
        IdToken::NotOffered => return Ok(Exchange::NotOffered),
        IdToken::Failed(reason) => return Ok(Exchange::Failed(reason)),
        IdToken::Token(token) => token,
    };

    let registry_url = registry.url.url();
    let registry_host = bstr::BStr::new(registry_url.host);

    // At the root of the registry's host, also for a registry URL that has a
    // path: that is where npm asks.
    let mut url: Vec<u8> = Vec::new();
    let _ = write!(
        &mut url,
        "{}://{}/-/npm/v1/oidc/token/exchange/package/{}",
        bstr::BStr::new(registry_url.display_protocol()),
        registry_host,
        bun_fmt::dependency_url(package_name),
    );

    let reply = match send(http::Method::POST, &url, &id_token)? {
        Ok(reply) => reply,
        Err(err) => {
            return Ok(Exchange::Failed(sentence(format_args!(
                "could not reach {} for the token exchange: {}",
                registry_host,
                err.name(),
            ))));
        }
    };

    if !(200..300).contains(&reply.status) {
        // This endpoint says why in `message`; other npm endpoints use `error`.
        let message = match json_string(&reply.body, b"message")? {
            Some(message) => Some(message),
            None => json_string(&reply.body, b"error")?,
        };
        return Ok(Exchange::Failed(match message {
            Some(message) => sentence(format_args!(
                "{} answered the token exchange for \"{}\" with HTTP {}: {}",
                registry_host,
                bstr::BStr::new(package_name),
                reply.status,
                bstr::BStr::new(&message),
            )),
            None => sentence(format_args!(
                "{} answered the token exchange for \"{}\" with HTTP {}",
                registry_host,
                bstr::BStr::new(package_name),
                reply.status,
            )),
        }));
    }

    Ok(match json_string(&reply.body, b"token")? {
        Some(token) if !token.is_empty() => Exchange::Token(token),
        _ => Exchange::Failed(sentence(format_args!(
            "{} answered the token exchange for \"{}\" without a token",
            registry_host,
            bstr::BStr::new(package_name),
        ))),
    })
}

/// Prints the sentence of an [`Exchange::Failed`].
pub(crate) fn print_failure(reason: &[u8]) {
    bun_core::note!(
        "trusted publishing (OIDC) failed: {}",
        bstr::BStr::new(reason)
    );
}

enum IdToken {
    NotOffered,
    Token(Box<[u8]>),
    Failed(Box<[u8]>),
}

/// The id token of this CI job for `registry`.
fn id_token(registry: &Npm::Registry::Scope) -> Result<IdToken, AllocError> {
    // GitLab CI and CircleCI put the token in the environment. On GitHub
    // Actions the variable replaces the request below, as it does for npm.
    if let Some(token) = env_var::NPM_ID_TOKEN.get()
        && !token.is_empty()
    {
        return Ok(IdToken::Token(token.into()));
    }

    if !env_var::GITHUB_ACTIONS.get().unwrap_or(false) {
        return Ok(IdToken::NotOffered);
    }
    // A job has these two only with `permissions: id-token: write`.
    let (Some(request_url), Some(request_token)) = (
        env_var::ACTIONS_ID_TOKEN_REQUEST_URL.get(),
        env_var::ACTIONS_ID_TOKEN_REQUEST_TOKEN.get(),
    ) else {
        return Ok(IdToken::NotOffered);
    };
    if request_url.is_empty() || request_token.is_empty() {
        return Ok(IdToken::NotOffered);
    }

    // The audience names the registry the token is for: `npm:registry.npmjs.org`.
    let registry_hostname = registry.url.url().hostname;
    let mut url: Vec<u8> = Vec::with_capacity(request_url.len() + 32 + registry_hostname.len());
    url.extend_from_slice(request_url);
    url.push(if strings::contains_char(request_url, b'?') {
        b'&'
    } else {
        b'?'
    });
    url.extend_from_slice(b"audience=npm%3A");
    for &byte in registry_hostname {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            url.push(byte);
        } else {
            let _ = write!(&mut url, "%{:02X}", byte);
        }
    }

    let reply = match send(http::Method::GET, &url, request_token)? {
        Ok(reply) => reply,
        Err(err) => {
            return Ok(IdToken::Failed(sentence(format_args!(
                "could not request an id token from GitHub Actions: {}",
                err.name(),
            ))));
        }
    };
    if !(200..300).contains(&reply.status) {
        return Ok(IdToken::Failed(sentence(format_args!(
            "GitHub Actions answered the id token request with HTTP {}",
            reply.status,
        ))));
    }
    Ok(match json_string(&reply.body, b"value")? {
        Some(token) if !token.is_empty() => IdToken::Token(token),
        _ => IdToken::Failed(sentence(format_args!(
            "GitHub Actions answered the id token request without a token",
        ))),
    })
}

struct Reply {
    status: u32,
    body: Vec<u8>,
}

/// Sends one request that has a bearer token and no body. The inner error is
/// a request that got no response.
fn send(
    method: http::Method,
    url: &[u8],
    bearer: &[u8],
) -> Result<Result<Reply, http::Error>, AllocError> {
    let mut authorization: Vec<u8> = Vec::with_capacity(b"Bearer ".len() + bearer.len());
    authorization.extend_from_slice(b"Bearer ");
    authorization.extend_from_slice(bearer);
    let is_post = method == http::Method::POST;

    let mut headers = http::HeaderBuilder::default();
    headers.count(b"accept", b"application/json");
    headers.count(b"authorization", &authorization);
    if is_post {
        headers.count(b"content-length", b"0");
    }
    headers.allocate()?;
    headers.append(b"accept", b"application/json");
    headers.append(b"authorization", &authorization);
    if is_post {
        headers.append(b"content-length", b"0");
    }

    let mut response_buf = MutableString::init(1024)?;
    let mut req = http::AsyncHTTP::init_sync(
        method,
        URL::parse(url),
        headers.entries,
        headers.content.written_slice(),
        b"",
        None,
        http::FetchRedirect::Follow,
    );
    match req.send_sync(&mut response_buf) {
        Ok(res) => Ok(Ok(Reply {
            status: res.status_code(),
            body: core::mem::take(&mut response_buf.list),
        })),
        Err(http::Error::Alloc(err)) => Err(err),
        Err(err) => Ok(Err(err)),
    }
}

/// The string at `key` when `body` is a JSON object that has one there.
fn json_string(body: &[u8], key: &[u8]) -> Result<Option<Box<[u8]>>, AllocError> {
    let source = bun_ast::Source::init_path_string(b"???", body);
    let mut log = bun_ast::Log::init();
    let bump = bun_alloc::Arena::new();
    let json = match json_mod::parse_utf8(&source, &mut log, &bump) {
        Ok(json) => json,
        Err(bun_parsers::Error::Alloc(err)) => return Err(err),
        Err(_) => return Ok(None),
    };
    let Some(property) = json.as_property(key) else {
        return Ok(None);
    };
    Ok(property.expr.as_string_cloned(&bump)?.map(Box::from))
}

fn sentence(args: core::fmt::Arguments<'_>) -> Box<[u8]> {
    let mut bytes: Vec<u8> = Vec::new();
    let _ = bytes.write_fmt(args);
    bytes.into_boxed_slice()
}
