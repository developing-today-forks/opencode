import { Schema } from "effect"

// Named because `createSchemaClass` subclasses reference this base through the
// `create` overloads: declaration emit cannot serialize the inferred cyclic type.
export interface NamedErrorClass<Name extends string = string, Data = unknown> {
  new (data: Data, options?: ErrorOptions): NamedError & { readonly data: Data; readonly name: Name }
  readonly Schema: Schema.Top
  readonly EffectSchema: Schema.Top
  readonly tag: Name
  isInstance(input: unknown): input is NamedError
}

export abstract class NamedError extends Error {
  abstract schema(): Schema.Top
  abstract toObject(): { name: string; data: unknown }

  static hasName(error: unknown, name: string): boolean {
    return typeof error === "object" && error !== null && "name" in error && error.name === name
  }

  static create<Name extends string, Fields extends Schema.Struct.Fields>(
    name: Name,
    fields: Fields,
  ): ReturnType<typeof NamedError.createSchemaClass<Name, Schema.Struct<Fields>>>
  static create<Name extends string, DataSchema extends Schema.Top>(
    name: Name,
    data: DataSchema,
  ): ReturnType<typeof NamedError.createSchemaClass<Name, DataSchema>>
  static create<Name extends string>(name: Name, data: Schema.Top | Schema.Struct.Fields): NamedErrorClass<Name, any> {
    return NamedError.createSchemaClass(name, Schema.isSchema(data) ? data : Schema.Struct(data))
  }

  public static createSchemaClass<Name extends string, DataSchema extends Schema.Top>(
    name: Name,
    data: DataSchema,
  ): NamedErrorClass<Name, Schema.Schema.Type<DataSchema>> {
    const schema = Schema.Struct({
      name: Schema.Literal(name),
      data,
    }).annotate({ identifier: name })
    type Data = Schema.Schema.Type<DataSchema>

    const result = class extends NamedError {
      public static readonly Schema = schema
      public static readonly EffectSchema = schema
      public static readonly tag = name

      public override readonly name = name

      constructor(
        public readonly data: Data,
        options?: ErrorOptions,
      ) {
        super(name, options)
        this.name = name
      }

      static isInstance(input: unknown): input is NamedError {
        return NamedError.hasName(input, name)
      }

      schema() {
        return schema
      }

      toObject() {
        return {
          name: name,
          data: this.data,
        }
      }
    }
    Object.defineProperty(result, "name", { value: name })
    return result
  }

  public static readonly Unknown = NamedError.create("UnknownError", {
    message: Schema.String,
    ref: Schema.optional(Schema.String),
  })
}
