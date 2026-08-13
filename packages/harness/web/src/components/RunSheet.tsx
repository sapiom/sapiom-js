import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { ErrorObject } from "ajv";
import type {
  WorkflowInfo,
  WorkflowInputContractResponse,
} from "@shared/types";

import type { RunTarget } from "../lib/use-harness-state";
import { useDismissable } from "../lib/use-dismissable";
import {
  createInputValidator,
  humanizeValidationError,
  loadStoredRunInput,
  resetValueForSchema,
  saveStoredRunInput,
  schemaSignature,
  type InputValidator,
} from "../lib/run-input";
import { Icon } from "./Icon";
import { SchemaInputFields } from "./SchemaInputFields";

interface RunSheetProps {
  workflow: WorkflowInfo;
  target: RunTarget;
  loadContract: (
    workflowPath: string,
  ) => Promise<WorkflowInputContractResponse>;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
  /** Receives the exact value parsed from the editor. */
  onRun: (input: unknown) => void;
}

function pretty(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

/**
 * Unified execution entry point. Slice one intentionally starts with the
 * always-available raw editor; schema-native controls layer onto the same
 * contract and submit path without changing execution semantics.
 */
export function RunSheet({
  workflow,
  target,
  loadContract,
  onClose,
  returnFocus,
  onRun,
}: RunSheetProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [contract, setContract] =
    useState<WorkflowInputContractResponse | null>(null);
  const [input, setInput] = useState<unknown>({});
  const [value, setValue] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ErrorObject[]>([]);
  const [validator, setValidator] = useState<InputValidator | null>(null);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [staleSavedInput, setStaleSavedInput] = useState(false);

  useDismissable(true, { onDismiss: onClose, containerRef: panelRef });

  useEffect(
    () => () => {
      returnFocus?.focus();
    },
    [returnFocus],
  );

  useEffect(() => {
    let current = true;
    setContract(null);
    setError(null);
    void loadContract(workflow.path)
      .then((next) => {
        if (!current) return;
        setContract(next);
        const stored = loadStoredRunInput(workflow.path);
        let initial = stored?.value ?? next.example;
        let nextValidator: InputValidator | null = null;
        let nextErrors: ErrorObject[] = [];
        if (next.status === "available") {
          initial = stored?.value ?? resetValueForSchema(next.jsonSchema);
          try {
            nextValidator = createInputValidator(next.jsonSchema);
            nextErrors = nextValidator.validateValue(initial);
          } catch {
            // A schema AJV cannot compile remains runnable through whole-input
            // JSON mode. The server contract is still shown honestly.
            setMode("json");
            setError(
              "This contract uses a schema branch Studio cannot render. Edit the complete JSON input instead.",
            );
          }
        } else {
          setMode("json");
        }
        setValidator(nextValidator);
        setInput(initial);
        setValidationErrors(nextErrors);
        setStaleSavedInput(Boolean(stored && nextErrors.length > 0));
        setValue(pretty(initial));
        requestAnimationFrame(() =>
          (editorRef.current ??
            panelRef.current?.querySelector<HTMLElement>("input, select, textarea"))?.focus(),
        );
      })
      .catch((err: unknown) => {
        if (!current) return;
        setContract({
          status: "unavailable",
          jsonSchema: null,
          example: {},
          reason:
            "Studio couldn't load this agent's input contract. You can still run it with raw JSON.",
        });
        const stored = loadStoredRunInput(workflow.path);
        const initial = stored?.value ?? {};
        setInput(initial);
        setValue(pretty(initial));
        setMode("json");
        setError(null);
        requestAnimationFrame(() => editorRef.current?.focus());
      });
    return () => {
      current = false;
    };
  }, [loadContract, workflow.path]);

  const submit = (): void => {
    if (!contract) return;
    let parsed = input;
    if (mode === "json") {
      try {
        parsed = JSON.parse(value);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Enter valid JSON.");
        editorRef.current?.focus();
        return;
      }
    }
    const nextErrors = validator?.validateValue(parsed) ?? [];
    setValidationErrors(nextErrors);
    if (nextErrors.length > 0) {
      setError("Fix the highlighted input before running.");
      return;
    }
    const signature =
      contract.status === "available"
        ? schemaSignature(contract.jsonSchema)
        : null;
    saveStoredRunInput(workflow.path, parsed, signature);
    setError(null);
    onRun(parsed);
  };

  const updateInput = (next: unknown): void => {
    setInput(next);
    setValue(pretty(next));
    const nextErrors = validator?.validateValue(next) ?? [];
    setValidationErrors(nextErrors);
    if (nextErrors.length === 0) {
      setError(null);
      setStaleSavedInput(false);
    }
  };

  const switchMode = (nextMode: "form" | "json"): void => {
    if (nextMode === mode) return;
    if (nextMode === "form") {
      try {
        const parsed: unknown = JSON.parse(value);
        setInput(parsed);
        setValidationErrors(validator?.validateValue(parsed) ?? []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Enter valid JSON.");
        return;
      }
    } else {
      setValue(pretty(input));
      setError(null);
    }
    setMode(nextMode);
  };

  return (
    <div className="modal-backdrop run-sheet-backdrop">
      <div
        className="modal run-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-sheet-title"
        ref={panelRef}
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            const focusable = Array.from(
              panelRef.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]',
              ) ?? [],
            ).filter((element) => element.offsetParent !== null);
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (first && last && event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (first && last && !event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      >
        <header className="run-sheet-header">
          <div>
            <div className="run-sheet-kicker">
              {target === "local" ? "Local execution" : "Cloud execution"}
            </div>
            <h2 id="run-sheet-title">Run {workflow.name}</h2>
            <p>
              Review the agent input, then follow the execution live in Steps.
            </p>
          </div>
          <button
            className="theme-toggle modal-close"
            type="button"
            aria-label="Close run dialog"
            onClick={onClose}
          >
            <Icon name="X" size={14} />
          </button>
        </header>

        <div className="run-sheet-body">
          <div className="run-sheet-field-head">
            <label htmlFor="run-sheet-json">Input</label>
            {contract?.status === "available" && validator ? (
              <div className="run-input-mode" role="tablist" aria-label="Input editor mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "form"}
                  onClick={() => switchMode("form")}
                >
                  Fields
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "json"}
                  onClick={() => switchMode("json")}
                >
                  JSON
                </button>
              </div>
            ) : (
              <span>JSON</span>
            )}
          </div>
          {!contract ? (
            <div className="run-sheet-loading" role="status">
              Loading input contract…
            </div>
          ) : (
            <>
              {contract.status === "none" && (
                <p className="run-sheet-notice">
                  This agent declares no input contract. Pass an object or any
                  JSON value it accepts.
                </p>
              )}
              {contract.status === "unavailable" && (
                <p className="run-sheet-notice" data-tone="warning">
                  {contract.reason}
                </p>
              )}
              {staleSavedInput && (
                <div className="run-sheet-stale" role="status">
                  <span>
                    The saved input no longer matches this agent's contract.
                    Your values are still here so you can repair them.
                  </span>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      if (contract.status !== "available") return;
                      updateInput(resetValueForSchema(contract.jsonSchema));
                    }}
                  >
                    Reset to defaults
                  </button>
                </div>
              )}
              {mode === "form" && contract.status === "available" && validator ? (
                <div className="run-schema-form">
                  <SchemaInputFields
                    schema={contract.jsonSchema}
                    value={input}
                    onChange={updateInput}
                    errors={validationErrors}
                  />
                  {!staleSavedInput && (
                    <button
                      type="button"
                      className="btn-ghost run-sheet-reset"
                      onClick={() =>
                        updateInput(resetValueForSchema(contract.jsonSchema))
                      }
                    >
                      Reset to defaults
                    </button>
                  )}
                </div>
              ) : (
                <textarea
                  id="run-sheet-json"
                  ref={editorRef}
                  className="run-sheet-editor"
                  value={value}
                  onChange={(event) => {
                    setValue(event.target.value);
                    setError(null);
                  }}
                  rows={12}
                  spellCheck={false}
                  aria-invalid={Boolean(error || validationErrors.length)}
                  aria-describedby={error ? "run-sheet-error" : undefined}
                />
              )}
            </>
          )}
          {mode === "json" && validationErrors.length > 0 && (
            <ul className="run-sheet-validation-list">
              {validationErrors.map((item, index) => (
                <li key={index}>{humanizeValidationError(item)}</li>
              ))}
            </ul>
          )}
          {error && (
            <div id="run-sheet-error" className="modal-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <footer className="run-sheet-actions">
          <span className="run-sheet-shortcut">⌘/Ctrl + Enter</span>
          <button className="btn-ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            type="button"
            disabled={!contract}
            onClick={submit}
            data-testid="run-sheet-submit"
          >
            <Icon name="Play" size={14} />
            Run {target === "local" ? "locally" : "in cloud"}
          </button>
        </footer>
      </div>
    </div>
  );
}
