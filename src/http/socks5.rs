//! SOCKS5 client negotiation (RFC 1928) with username/password authentication
//! (RFC 1929), for `socks5://` and `socks5h://` proxies.
//!
//! [`Handshake`] does no I/O. [`HTTPClient`](crate::HTTPClient) owns the
//! socket: it writes [`Handshake::unsent`] and feeds every read to
//! [`Handshake::receive`] until that returns [`Progress::Established`]. From
//! then on the socket is a plain byte pipe to the target, so an `http://`
//! request is written to it as if it were a direct connection and an
//! `https://` request starts the same [`ProxyTunnel`](crate::ProxyTunnel) an
//! HTTP `CONNECT` proxy gets.
//!
//! The target is always sent as a domain name (unless the URL has an IP
//! literal), so the proxy does the DNS lookup: what curl calls `socks5h`. Like
//! Go's `net/http`, `socks5://` behaves the same way.

use core::net::IpAddr;

const VERSION: u8 = 0x05;
const AUTH_VERSION: u8 = 0x01;

const METHOD_NONE: u8 = 0x00;
const METHOD_USERNAME_PASSWORD: u8 = 0x02;
const METHOD_NOT_ACCEPTABLE: u8 = 0xFF;

const CMD_CONNECT: u8 = 0x01;

const ATYP_IPV4: u8 = 0x01;
const ATYP_DOMAIN: u8 = 0x03;
const ATYP_IPV6: u8 = 0x04;

/// Why a SOCKS proxy did not open the connection. The variant name is the
/// `code` of the error `fetch()` rejects with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error, strum::IntoStaticStr)]
pub enum SocksError {
    /// The peer's reply is not a SOCKS5 message: most often the proxy URL
    /// points at an HTTP proxy or some other server.
    #[error("SocksProxyInvalidResponse")]
    SocksProxyInvalidResponse,
    /// The proxy accepts neither "no authentication" nor (when the proxy URL
    /// has credentials) username/password.
    #[error("SocksProxyAuthenticationRequired")]
    SocksProxyAuthenticationRequired,
    #[error("SocksProxyAuthenticationFailed")]
    SocksProxyAuthenticationFailed,
    /// A username, password or hostname is longer than the one length byte
    /// SOCKS5 gives it can say. Nothing was sent to the proxy.
    #[error("SocksProxyFieldTooLong")]
    SocksProxyFieldTooLong,
    #[error("SocksProxyGeneralFailure")]
    SocksProxyGeneralFailure,
    #[error("SocksProxyConnectionNotAllowed")]
    SocksProxyConnectionNotAllowed,
    #[error("SocksProxyNetworkUnreachable")]
    SocksProxyNetworkUnreachable,
    #[error("SocksProxyHostUnreachable")]
    SocksProxyHostUnreachable,
    #[error("SocksProxyConnectionRefused")]
    SocksProxyConnectionRefused,
    #[error("SocksProxyTTLExpired")]
    SocksProxyTTLExpired,
    #[error("SocksProxyCommandNotSupported")]
    SocksProxyCommandNotSupported,
    #[error("SocksProxyAddressTypeNotSupported")]
    SocksProxyAddressTypeNotSupported,
}

impl SocksError {
    /// RFC 1928 section 6, the `REP` field of a reply that is not `succeeded`.
    fn from_reply(rep: u8) -> Self {
        match rep {
            0x02 => Self::SocksProxyConnectionNotAllowed,
            0x03 => Self::SocksProxyNetworkUnreachable,
            0x04 => Self::SocksProxyHostUnreachable,
            0x05 => Self::SocksProxyConnectionRefused,
            0x06 => Self::SocksProxyTTLExpired,
            0x07 => Self::SocksProxyCommandNotSupported,
            0x08 => Self::SocksProxyAddressTypeNotSupported,
            _ => Self::SocksProxyGeneralFailure,
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::SocksProxyInvalidResponse => {
                "The proxy did not answer like a SOCKS5 server. Is the proxy URL correct?"
            }
            Self::SocksProxyAuthenticationRequired => {
                "The SOCKS proxy accepted none of the offered authentication methods. If it needs a username and password, put them in the proxy URL."
            }
            Self::SocksProxyAuthenticationFailed => {
                "The SOCKS proxy rejected the username and password."
            }
            Self::SocksProxyFieldTooLong => {
                "SOCKS5 cannot carry a username, password or hostname longer than 255 bytes."
            }
            Self::SocksProxyGeneralFailure => "The SOCKS proxy failed to connect to the host.",
            Self::SocksProxyConnectionNotAllowed => {
                "The SOCKS proxy's rules do not allow a connection to the host."
            }
            Self::SocksProxyNetworkUnreachable => {
                "The SOCKS proxy cannot reach the host's network."
            }
            Self::SocksProxyHostUnreachable => "The SOCKS proxy cannot reach the host.",
            Self::SocksProxyConnectionRefused => {
                "The host refused the SOCKS proxy's connection. Is the port correct?"
            }
            Self::SocksProxyTTLExpired => {
                "The SOCKS proxy's connection to the host timed out (TTL expired)."
            }
            Self::SocksProxyCommandNotSupported => {
                "The SOCKS proxy does not support the CONNECT command."
            }
            Self::SocksProxyAddressTypeNotSupported => {
                "The SOCKS proxy does not support the host's address type."
            }
        }
    }
}

/// Which reply [`Handshake::receive`] is waiting for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Step {
    /// The method selection that answers the greeting.
    Method,
    /// The status that answers the username/password request.
    Auth,
    /// The reply to the CONNECT request.
    Connect,
}

pub(crate) enum Progress {
    /// The reply is not complete yet; wait for more bytes.
    NeedMore,
    /// The proxy is connected to the target. `rest` is whatever arrived after
    /// its reply, which already belongs to the target's side of the pipe.
    Established { rest: Vec<u8> },
}

/// One connection's SOCKS state, kept in
/// [`InternalState`](crate::InternalState) so every new connection attempt
/// (redirect hop, retry) starts from `None`.
#[derive(Default)]
pub(crate) enum Negotiation {
    /// This connection has not spoken SOCKS: there is no SOCKS proxy, the
    /// negotiation has not begun, or the socket came from the keep-alive pool
    /// with its tunnel already up.
    #[default]
    None,
    Pending(Box<Handshake>),
    /// The socket now reaches exactly one target. Only a tunnel, which the
    /// pool keys on that target, may be kept alive.
    Established,
}

impl Negotiation {
    pub(crate) fn is_pending(&self) -> bool {
        matches!(self, Self::Pending(_))
    }

    pub(crate) fn is_established(&self) -> bool {
        matches!(self, Self::Established)
    }
}

pub(crate) struct Handshake {
    step: Step,
    /// The RFC 1929 request, when the proxy URL has credentials.
    auth: Option<Vec<u8>>,
    connect: Vec<u8>,
    /// The message being written; `sent` bytes of it are out.
    outgoing: Vec<u8>,
    sent: usize,
    /// Reply bytes that do not make up a whole message yet.
    incoming: Vec<u8>,
}

impl Handshake {
    /// `username`/`password` are the percent-decoded userinfo of the proxy URL;
    /// `hostname` is the target's, with the brackets of an IPv6 literal.
    pub(crate) fn new(
        username: &[u8],
        password: &[u8],
        hostname: &[u8],
        port: u16,
    ) -> Result<Self, SocksError> {
        // RFC 1929 wants at least one byte in each field. A URL with only one
        // of the two sends the other empty, as curl does, and leaves the
        // verdict to the proxy.
        let auth = if username.is_empty() && password.is_empty() {
            None
        } else {
            let (Ok(ulen), Ok(plen)) = (u8::try_from(username.len()), u8::try_from(password.len()))
            else {
                return Err(SocksError::SocksProxyFieldTooLong);
            };
            let mut request = Vec::with_capacity(3 + username.len() + password.len());
            request.push(AUTH_VERSION);
            request.push(ulen);
            request.extend_from_slice(username);
            request.push(plen);
            request.extend_from_slice(password);
            Some(request)
        };

        let mut connect = Vec::with_capacity(7 + hostname.len());
        connect.extend_from_slice(&[VERSION, CMD_CONNECT, 0x00]);
        let unbracketed = hostname
            .strip_prefix(b"[")
            .and_then(|h| h.strip_suffix(b"]"))
            .unwrap_or(hostname);
        match bun_core::ip_address::to_ip_address(unbracketed) {
            Some(IpAddr::V4(ip)) => {
                connect.push(ATYP_IPV4);
                connect.extend_from_slice(&ip.octets());
            }
            Some(IpAddr::V6(ip)) => {
                connect.push(ATYP_IPV6);
                connect.extend_from_slice(&ip.octets());
            }
            None => {
                let Ok(len) = u8::try_from(hostname.len()) else {
                    return Err(SocksError::SocksProxyFieldTooLong);
                };
                connect.push(ATYP_DOMAIN);
                connect.push(len);
                connect.extend_from_slice(hostname);
            }
        }
        connect.extend_from_slice(&port.to_be_bytes());

        let greeting = if auth.is_some() {
            vec![VERSION, 2, METHOD_NONE, METHOD_USERNAME_PASSWORD]
        } else {
            vec![VERSION, 1, METHOD_NONE]
        };

        Ok(Self {
            step: Step::Method,
            auth,
            connect,
            outgoing: greeting,
            sent: 0,
            incoming: Vec::new(),
        })
    }

    /// The part of the current message the socket has not taken yet.
    pub(crate) fn unsent(&self) -> &[u8] {
        &self.outgoing[self.sent..]
    }

    pub(crate) fn did_send(&mut self, amount: usize) {
        self.sent = (self.sent + amount).min(self.outgoing.len());
    }

    fn send(&mut self, message: Vec<u8>) {
        self.outgoing = message;
        self.sent = 0;
    }

    /// Feed bytes read from the proxy. After `Ok(NeedMore)`, [`Self::unsent`]
    /// may hold the next message to write.
    pub(crate) fn receive(&mut self, data: &[u8]) -> Result<Progress, SocksError> {
        self.incoming.extend_from_slice(data);
        loop {
            // The proxy only ever answers a message it has received in full.
            if !self.unsent().is_empty() && !self.incoming.is_empty() {
                return Err(SocksError::SocksProxyInvalidResponse);
            }
            match self.step {
                Step::Method => {
                    let &[version, method, ..] = self.incoming.as_slice() else {
                        return self.need_more(VERSION);
                    };
                    if version != VERSION {
                        return Err(SocksError::SocksProxyInvalidResponse);
                    }
                    self.incoming.drain(..2);
                    match method {
                        METHOD_NONE => {
                            self.step = Step::Connect;
                            let connect = core::mem::take(&mut self.connect);
                            self.send(connect);
                        }
                        METHOD_USERNAME_PASSWORD => {
                            // Chosen without having been offered.
                            let Some(auth) = self.auth.take() else {
                                return Err(SocksError::SocksProxyInvalidResponse);
                            };
                            self.step = Step::Auth;
                            self.send(auth);
                        }
                        METHOD_NOT_ACCEPTABLE => {
                            return Err(SocksError::SocksProxyAuthenticationRequired);
                        }
                        _ => return Err(SocksError::SocksProxyInvalidResponse),
                    }
                }
                Step::Auth => {
                    let &[version, status, ..] = self.incoming.as_slice() else {
                        return self.need_more(AUTH_VERSION);
                    };
                    if version != AUTH_VERSION {
                        return Err(SocksError::SocksProxyInvalidResponse);
                    }
                    if status != 0 {
                        return Err(SocksError::SocksProxyAuthenticationFailed);
                    }
                    self.incoming.drain(..2);
                    self.step = Step::Connect;
                    let connect = core::mem::take(&mut self.connect);
                    self.send(connect);
                }
                Step::Connect => {
                    // VER REP RSV ATYP BND.ADDR BND.PORT
                    let &[version, rep, _, atyp, ..] = self.incoming.as_slice() else {
                        return self.need_more(VERSION);
                    };
                    if version != VERSION {
                        return Err(SocksError::SocksProxyInvalidResponse);
                    }
                    if rep != 0 {
                        return Err(SocksError::from_reply(rep));
                    }
                    let address_len = match atyp {
                        ATYP_IPV4 => 4,
                        ATYP_IPV6 => 16,
                        ATYP_DOMAIN => match self.incoming.get(4) {
                            Some(&len) => 1 + len as usize,
                            None => return Ok(Progress::NeedMore),
                        },
                        _ => return Err(SocksError::SocksProxyInvalidResponse),
                    };
                    let reply_len = 4 + address_len + 2;
                    if self.incoming.len() < reply_len {
                        return Ok(Progress::NeedMore);
                    }
                    let rest = self.incoming.split_off(reply_len);
                    return Ok(Progress::Established { rest });
                }
            }
        }
    }

    /// A short read is only "need more" while what did arrive can still be
    /// the start of a reply; an HTTP server's `H` is rejected at once.
    fn need_more(&self, version: u8) -> Result<Progress, SocksError> {
        match self.incoming.first() {
            Some(&first) if first != version => Err(SocksError::SocksProxyInvalidResponse),
            _ => Ok(Progress::NeedMore),
        }
    }
}
