//! Serde helpers the generated types use to write numbers as `JSON.stringify` does.

use serde::Serializer;

/// A protocol number that is not an integer schema: a whole value is written as `3`, not `3.0`, so
/// request bodies match the TypeScript client byte for byte.
pub fn number<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    // `fract` is NaN for non-finite values, which serde_json writes as `null`, as JavaScript does.
    if value.fract() == 0.0 && value.abs() < 9_223_372_036_854_775_808.0 {
        return serializer.serialize_i64(*value as i64);
    }
    serializer.serialize_f64(*value)
}

pub fn option_number<S: Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(value) => number(value, serializer),
        None => serializer.serialize_none(),
    }
}

/// For an optional and nullable number: `Some(None)` is written as `null`, and `Some(Some(value))`
/// as [`option_number`] writes it. A `None` field is skipped by its `skip_serializing_if`.
pub fn double_option_number<S: Serializer>(
    value: &Option<Option<f64>>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(value) => option_number(value, serializer),
        None => serializer.serialize_none(),
    }
}

#[cfg(test)]
mod tests {
    use serde::Serialize;

    use super::*;

    #[derive(Serialize)]
    struct Field {
        #[serde(
            serialize_with = "double_option_number",
            skip_serializing_if = "Option::is_none"
        )]
        value: Option<Option<f64>>,
    }

    #[test]
    fn double_option_number_writes_like_json_stringify() {
        let json = |value: Option<Option<f64>>| serde_json::to_string(&Field { value }).unwrap();
        assert_eq!(json(Some(Some(3.0))), "{\"value\":3}");
        assert_eq!(json(Some(Some(3.5))), "{\"value\":3.5}");
        assert_eq!(json(Some(None)), "{\"value\":null}");
        assert_eq!(json(None), "{}");
    }
}
