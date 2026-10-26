#![warn(unused_must_use)]
pub mod acl;
pub mod copy;
pub mod crate_error;
pub mod error;
pub mod metadata;
pub mod storage_class;

pub use crate_error::Error;

pub mod credentials;

pub use acl::ACL;
pub use copy::{CopyHeaders, CopyHeadersError, MetadataDirective};
pub use credentials::*;
pub use metadata::{AmzHeader, AmzHeaders, Metadata, MetadataError};
pub use storage_class::StorageClass;
