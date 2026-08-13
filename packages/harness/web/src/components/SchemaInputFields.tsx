import { useEffect, useId, useRef, useState } from "react";
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
    : (fallback ?? "Value");
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
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const serialized = jsonValue(value);
  const lastCommitted = useRef(serialized);
  const [text, setText] = useState(serialized);
  const [parseError, setParseError] = useState<string | null>(null);
  const errorId = parseError ? `${id}-error` : undefined;

  useEffect(() => {
    if (serialized === lastCommitted.current) return;
    lastCommitted.current = serialized;
    setText(serialized);
    setParseError(null);
  }, [serialized]);

  return (
    <div className="schema-field schema-json-field">
      <label htmlFor={id}>{label}</label>
      {description && <p id={descriptionId}>{description}</p>}
      <textarea
        id={id}
        value={text}
        rows={5}
        spellCheck={false}
        aria-invalid={Boolean(parseError)}
        aria-describedby={
          [descriptionId, errorId].filter(Boolean).join(" ") || undefined
        }
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
      {parseError && (
        <span id={errorId} className="schema-field-error">
          {parseError}
        </span>
      )}
    </div>
  );
}

function ScalarControl({
  schema,
  value,
  onChange,
  id,
  ariaLabel,
  describedBy,
  invalid = false,
  required = false,
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  id: string;
  ariaLabel?: string;
  describedBy?: string;
  invalid?: boolean;
  required?: boolean;
}): JSX.Element {
  if (Array.isArray(schema.enum)) {
    return (
      <select
        id={id}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        required={required}
        value={value === undefined ? "" : JSON.stringify(value)}
        onChange={(event) =>
          onChange(
            event.target.value === ""
              ? undefined
              : JSON.parse(event.target.value),
          )
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
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        required={required}
        value={value === true ? "true" : value === false ? "false" : ""}
        onChange={(event) =>
          onChange(
            event.target.value === ""
              ? undefined
              : event.target.value === "true",
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
      min={typeof schema.minimum === "number" ? schema.minimum : undefined}
      max={typeof schema.maximum === "number" ? schema.maximum : undefined}
      minLength={
        !numeric && typeof schema.minLength === "number"
          ? schema.minLength
          : undefined
      }
      maxLength={
        !numeric && typeof schema.maxLength === "number"
          ? schema.maxLength
          : undefined
      }
      pattern={
        !numeric && typeof schema.pattern === "string"
          ? schema.pattern
          : undefined
      }
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      required={required}
      value={
        typeof value === "string" || typeof value === "number" ? value : ""
      }
      placeholder={
        typeof schema.placeholder === "string" ? schema.placeholder : undefined
      }
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
  label,
}: SchemaInputFieldsProps): JSX.Element {
  const idBase = useId();
  const items = schema.items as JsonSchema;
  const values = Array.isArray(value) ? value : [];
  const minItems = typeof schema.minItems === "number" ? schema.minItems : 0;
  const maxItems =
    typeof schema.maxItems === "number"
      ? schema.maxItems
      : Number.POSITIVE_INFINITY;
  const arrayLabel = label ?? titleFor(schema);
  return (
    <div className="schema-array">
      {values.map((item, index) => {
        const itemPath = pointerChild(path ?? "", index);
        const id = `${idBase}-${index}`;
        const itemErrors = errorsAt(errors, itemPath);
        const errorId = itemErrors.length > 0 ? `${id}-errors` : undefined;
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
              ariaLabel={`${arrayLabel} item ${index + 1}`}
              describedBy={errorId}
              invalid={itemErrors.length > 0}
            />
            <button
              type="button"
              className="theme-toggle"
              aria-label={`Remove item ${index + 1}`}
              disabled={values.length <= minItems}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              <Icon name="X" size={13} />
            </button>
            {itemErrors.length > 0 && (
              <div id={errorId} className="schema-field-errors">
                {itemErrors.map((error, errorIndex) => (
                  <span className="schema-field-error" key={errorIndex}>
                    {humanizeValidationError(error)}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="btn-ghost schema-array-add"
        disabled={values.length >= maxItems}
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
  const id = useId();
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
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const requiredKeys = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter(
            (key): key is string => typeof key === "string",
          )
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
          const present = Object.prototype.hasOwnProperty.call(
            objectValue,
            key,
          );
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
                  onChange={(next) => onChange({ ...objectValue, [key]: next })}
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
                  Object.entries(objectValue).filter(
                    ([key]) => key in properties,
                  ),
                ),
                ...nextExtras,
              });
            }}
          />
        )}
      </div>
    );

    if (path === "") {
      const rootErrorId = fieldErrors.length > 0 ? `${id}-errors` : undefined;
      return (
        <div aria-describedby={rootErrorId}>
          {description && <p>{description}</p>}
          {content}
          {fieldErrors.length > 0 && (
            <div id={rootErrorId} className="schema-field-errors">
              {fieldErrors.map((error, index) => (
                <span className="schema-field-error" key={index}>
                  {humanizeValidationError(error)}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }
    const objectDescriptionId = description ? `${id}-description` : undefined;
    const objectErrorId = fieldErrors.length > 0 ? `${id}-errors` : undefined;
    return (
      <fieldset
        className="schema-object"
        aria-describedby={
          [objectDescriptionId, objectErrorId].filter(Boolean).join(" ") ||
          undefined
        }
      >
        <legend>
          {fieldLabel}
          {required && <span aria-label="required"> *</span>}
        </legend>
        {description && <p id={objectDescriptionId}>{description}</p>}
        {content}
        {fieldErrors.length > 0 && (
          <div id={objectErrorId} className="schema-field-errors">
            {fieldErrors.map((error, index) => (
              <span className="schema-field-error" key={index}>
                {humanizeValidationError(error)}
              </span>
            ))}
          </div>
        )}
      </fieldset>
    );
  }

  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = fieldErrors.length > 0 ? `${id}-errors` : undefined;
  if (schema.type === "array") {
    return (
      <fieldset
        className="schema-field schema-array-field"
        aria-describedby={
          [descriptionId, errorId].filter(Boolean).join(" ") || undefined
        }
      >
        <legend>
          {fieldLabel}
          {required && <span aria-label="required"> *</span>}
        </legend>
        {description && <p id={descriptionId}>{description}</p>}
        <ScalarArrayField
          schema={schema}
          value={value}
          onChange={onChange}
          errors={errors}
          path={path}
          label={fieldLabel}
        />
        {fieldErrors.length > 0 && (
          <div id={errorId} className="schema-field-errors">
            {fieldErrors.map((error, index) => (
              <span className="schema-field-error" key={index}>
                {humanizeValidationError(error)}
              </span>
            ))}
          </div>
        )}
      </fieldset>
    );
  }
  return (
    <div className="schema-field">
      <label htmlFor={id}>
        {fieldLabel}
        {required && <span aria-label="required"> *</span>}
      </label>
      {description && <p id={descriptionId}>{description}</p>}
      <ScalarControl
        schema={schema}
        value={value}
        onChange={onChange}
        id={id}
        describedBy={
          [descriptionId, errorId].filter(Boolean).join(" ") || undefined
        }
        invalid={fieldErrors.length > 0}
        required={required}
      />
      {fieldErrors.length > 0 && (
        <div id={errorId} className="schema-field-errors">
          {fieldErrors.map((error, index) => (
            <span className="schema-field-error" key={index}>
              {humanizeValidationError(error)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
