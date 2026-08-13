import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { ErrorObject } from "ajv";

import {
  fieldPathForError,
  humanizeValidationError,
  resetValueForSchema,
} from "../lib/run-input";
import { Icon } from "./Icon";

type JsonSchema = Record<string, unknown>;

interface SchemaInputFieldsProps {
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  errors: ErrorObject[];
  path?: string;
  label?: string;
  required?: boolean;
}

function pointerChild(path: string, key: string | number): string {
  const escaped = String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${escaped}`;
}

function errorsAt(errors: ErrorObject[], path: string): ErrorObject[] {
  return errors.filter((error) => fieldPathForError(error) === (path || "/"));
}

function titleFor(schema: JsonSchema, fallback?: string): string {
  return typeof schema.title === "string" && schema.title.trim()
    ? schema.title
    : fallback ?? "Value";
}

function descriptionFor(schema: JsonSchema): string | null {
  return typeof schema.description === "string" && schema.description.trim()
    ? schema.description
    : null;
}

function supportsNativeField(schema: JsonSchema): boolean {
  if (schema.$ref || schema.anyOf || schema.oneOf || schema.allOf) return false;
  if (Array.isArray(schema.enum)) return true;
  if (schema.type === "array") {
    const items = schema.items;
    return Boolean(
      items &&
        typeof items === "object" &&
        supportsNativeScalar(items as JsonSchema),
    );
  }
  return ["object", "string", "number", "integer", "boolean"].includes(
    String(schema.type),
  );
}

function supportsNativeScalar(schema: JsonSchema): boolean {
  if (schema.$ref || schema.anyOf || schema.oneOf || schema.allOf) return false;
  if (Array.isArray(schema.enum)) return true;
  return ["string", "number", "integer", "boolean"].includes(
    String(schema.type),
  );
}

function jsonValue(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function JsonField({
  value,
  onChange,
  label,
  description,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
  description?: string | null;
}): JSX.Element {
  const serialized = jsonValue(value);
  const lastCommitted = useRef(serialized);
  const [text, setText] = useState(serialized);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    if (serialized === lastCommitted.current) return;
    lastCommitted.current = serialized;
    setText(serialized);
    setParseError(null);
  }, [serialized]);

  return (
    <div className="schema-field schema-json-field">
      <label>{label}</label>
      {description && <p>{description}</p>}
      <textarea
        value={text}
        rows={5}
        spellCheck={false}
        aria-invalid={Boolean(parseError)}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            const parsed: unknown = JSON.parse(next);
            setParseError(null);
            lastCommitted.current = jsonValue(parsed);
            onChange(parsed);
          } catch (err) {
            setParseError(
              err instanceof Error ? err.message : "Enter valid JSON.",
            );
          }
        }}
      />
      {parseError && <span className="schema-field-error">{parseError}</span>}
    </div>
  );
}

function ScalarControl({
  schema,
  value,
  onChange,
  id,
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  id: string;
}): JSX.Element {
  if (Array.isArray(schema.enum)) {
    return (
      <select
        id={id}
        value={value === undefined ? "" : JSON.stringify(value)}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : JSON.parse(event.target.value))
        }
      >
        <option value="">Select…</option>
        {schema.enum.map((option, index) => (
          <option key={index} value={JSON.stringify(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  }

  if (schema.type === "boolean") {
    return (
      <select
        id={id}
        value={value === true ? "true" : value === false ? "false" : ""}
        onChange={(event) =>
          onChange(
            event.target.value === "" ? undefined : event.target.value === "true",
          )
        }
      >
        <option value="">Not set</option>
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  }

  const numeric = schema.type === "number" || schema.type === "integer";
  return (
    <input
      id={id}
      type={numeric ? "number" : "text"}
      step={schema.type === "integer" ? 1 : "any"}
      value={
        typeof value === "string" || typeof value === "number" ? value : ""
      }
      placeholder={typeof schema.placeholder === "string" ? schema.placeholder : undefined}
      onChange={(event) => {
        const next = event.target.value;
        if (!numeric) onChange(next);
        else onChange(next === "" ? undefined : Number(next));
      }}
    />
  );
}

function ScalarArrayField({
  schema,
  value,
  onChange,
  errors,
  path,
}: SchemaInputFieldsProps): JSX.Element {
  const items = schema.items as JsonSchema;
  const values = Array.isArray(value) ? value : [];
  return (
    <div className="schema-array">
      {values.map((item, index) => {
        const itemPath = pointerChild(path ?? "", index);
        const id = `schema-${itemPath.replaceAll("/", "-")}`;
        return (
          <div className="schema-array-row" key={index}>
            <ScalarControl
              schema={items}
              value={item}
              onChange={(next) => {
                const copy = [...values];
                copy[index] = next;
                onChange(copy);
              }}
              id={id}
            />
            <button
              type="button"
              className="theme-toggle"
              aria-label={`Remove item ${index + 1}`}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              <Icon name="X" size={13} />
            </button>
            {errorsAt(errors, itemPath).map((error, errorIndex) => (
              <span className="schema-field-error" key={errorIndex}>
                {humanizeValidationError(error)}
              </span>
            ))}
          </div>
        );
      })}
      <button
        type="button"
        className="btn-ghost schema-array-add"
        onClick={() => onChange([...values, resetValueForSchema(items)])}
      >
        <Icon name="Plus" size={13} /> Add item
      </button>
    </div>
  );
}

export function SchemaInputFields({
  schema,
  value,
  onChange,
  errors,
  path = "",
  label,
  required = true,
}: SchemaInputFieldsProps): JSX.Element {
  const fieldLabel = titleFor(schema, label);
  const description = descriptionFor(schema);
  const fieldErrors = errorsAt(errors, path);

  if (!supportsNativeField(schema)) {
    return (
      <JsonField
        value={value}
        onChange={onChange}
        label={fieldLabel}
        description={description}
      />
    );
  }

  if (schema.type === "object") {
    const objectValue =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const properties = (schema.properties ?? {}) as Record<
      string,
      JsonSchema
    >;
    const requiredKeys = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((key): key is string => typeof key === "string")
        : [],
    );
    const extras = Object.fromEntries(
      Object.entries(objectValue).filter(([key]) => !(key in properties)),
    );
    const content = (
      <div className="schema-object-fields">
        {Object.entries(properties).map(([key, child]) => {
          const childPath = pointerChild(path, key);
          const isRequired = requiredKeys.has(key);
          const present = Object.prototype.hasOwnProperty.call(objectValue, key);
          return (
            <div className="schema-property" key={key}>
              {!isRequired && (
                <label className="schema-optional-toggle">
                  <input
                    type="checkbox"
                    checked={present}
                    onChange={(event) => {
                      const copy = { ...objectValue };
                      if (event.target.checked) {
                        copy[key] = resetValueForSchema(child);
                      } else {
                        delete copy[key];
                      }
                      onChange(copy);
                    }}
                  />
                  Include {titleFor(child, key)}
                </label>
              )}
              {(isRequired || present) && (
                <SchemaInputFields
                  schema={child}
                  value={objectValue[key]}
                  onChange={(next) =>
                    onChange({ ...objectValue, [key]: next })
                  }
                  errors={errors}
                  path={childPath}
                  label={key}
                  required={isRequired}
                />
              )}
            </div>
          );
        })}
        {Object.keys(extras).length > 0 && (
          <JsonField
            value={extras}
            label="Additional fields"
            description="These values are not present in the current contract."
            onChange={(next) => {
              const nextExtras =
                next && typeof next === "object" && !Array.isArray(next)
                  ? (next as Record<string, unknown>)
                  : {};
              onChange({
                ...Object.fromEntries(
                  Object.entries(objectValue).filter(([key]) => key in properties),
                ),
                ...nextExtras,
              });
            }}
          />
        )}
      </div>
    );

    if (path === "") return content;
    return (
      <fieldset className="schema-object">
        <legend>
          {fieldLabel}
          {required && <span aria-label="required"> *</span>}
        </legend>
        {description && <p>{description}</p>}
        {content}
        {fieldErrors.map((error, index) => (
          <span className="schema-field-error" key={index}>
            {humanizeValidationError(error)}
          </span>
        ))}
      </fieldset>
    );
  }

  const id = `schema-${(path || "root").replaceAll("/", "-")}`;
  return (
    <div className="schema-field">
      <label htmlFor={id}>
        {fieldLabel}
        {required && <span aria-label="required"> *</span>}
      </label>
      {description && <p>{description}</p>}
      {schema.type === "array" ? (
        <ScalarArrayField
          schema={schema}
          value={value}
          onChange={onChange}
          errors={errors}
          path={path}
        />
      ) : (
        <ScalarControl
          schema={schema}
          value={value}
          onChange={onChange}
          id={id}
        />
      )}
      {fieldErrors.map((error, index) => (
        <span className="schema-field-error" key={index}>
          {humanizeValidationError(error)}
        </span>
      ))}
    </div>
  );
}
