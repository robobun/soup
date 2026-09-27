#![warn(unused_must_use)]
pub mod acl;
pub mod crate_error;
pub mod error;
pub mod metadata;
pub mod storage_class;

pub use crate_error::Error;

pub mod credentials;

pub use acl::ACL;
pub use credentials::*;
pub use metadata::{Metadata, MetadataEntry, MetadataError};
pub use storage_class::StorageClass;
