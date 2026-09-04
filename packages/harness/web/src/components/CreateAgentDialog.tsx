/**
 * Create an agent in a project you already picked (SAP-2981).
 *
 * The project is STATED, NOT CHOSEN. You clicked that row's menu — that is the
 * answer to "where", and re-asking it with a folder picker would be the same
 * subject confusion the rail's `+`/`×` pair had: a control that acts on one
 * noun while inviting you to pick another. So the destination is a sentence at
 * the top of the dialog, spelled out to its absolute path because a rail label
 * can be a widened or shared name and this creates a real directory.
 *
 * WHAT IT ASKS: a name, a starter, and — optionally — the first thing to build.
 * Nothing else, because nothing else is decidable here: the folder is known,
 * and the harness resolves dependency versions itself.
 *
 * CREATION COMPLETES BEFORE THE CHAT STARTS. `onCreate` resolves only once the
 * server has scaffolded the agent and rescanned it into the registry, so a
 * refusal lands in THIS dialog as a sentence (the field keeps what you typed,
 * ready to fix) rather than as a coding agent that was asked to do a filesystem
 * operation in English and got confused. The dialog stays up and busy while it
 * runs — the whole point is that the outcome is reported.
 *
 * The name is validated as you type against the SAME rule the endpoint refuses
 * with (`@shared/agent-name`). Two guards, one rule: a name the field accepts
 * and the server rejects reads as a broken app.
 */

import { useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import { refuseAgentName } from "@shared/agent-name";

import { errorMessage } from "../lib/api";
import type { StarterTemplate } from "../lib/templates";
import { STARTER_TEMPLATES } from "../lib/templates";
import { Dialog } from "./Dialog";

export function CreateAgentDialog({
  projectLabel,
  projectRoot,
  templates = STARTER_TEMPLATES,
  onCancel,
  onCreate,
  onBrowseTemplates,
}: {
  /** The project's rail label — what the user actually read on the row. */
  projectLabel: string;
  /** The absolute folder the agent is created in, spelled out. */
  projectRoot: string;
  /** Bundled starters. The gallery is a separate journey (see the footnote
   *  below `onBrowseTemplates`), so these are the ones this dialog offers. */
  templates?: readonly StarterTemplate[];
  onCancel: () => void;
  /** Rejects with the server's own sentence, which is shown in place of the
   *  hint. Resolves only once the agent exists. */
  onCreate: (input: {
    name: string;
    template: string;
    instruction: string;
  }) => Promise<void>;
  /** Leaves for the template gallery — the clone journey this dialog does not
   *  own. Omitted, the link is not rendered. */
  onBrowseTemplates?: () => void;
  /* NO `triggerRef`. Every door into this dialog is a control that unmounts
     when it is used — the project row's popover menu closes on click, the
     empty-project row is replaced by the agent it creates — so a ref handed in
     here would point at a detached node and Escape would restore focus to
     <body> anyway, only less obviously. Same reason the rail's remove-confirm
     takes the `⋮` itself rather than the menu item. */
}): JSX.Element {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState(templates[0]?.id ?? "default");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dialog opens on the field it is asking about. Handed to `Dialog` rather
  // than focused from an effect here: initial focus is the shell's job, and one
  // dialog reaching into the DOM on its own is how the eleven of them stopped
  // agreeing in the first place.
  const nameRef = useRef<HTMLInputElement>(null);

  // Only after something has been typed: an empty field on open is not a
  // mistake the user has made yet, and greeting them with "Give the agent a
  // name" is a scold, not a hint.
  const nameRefusal = useMemo(
    () => (name === "" ? null : refuseAgentName(name)),
    [name],
  );
  const submittable = name.trim() !== "" && nameRefusal == null && !busy;

  const submit = async (): Promise<void> => {
    if (!submittable) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name, template, instruction: instruction.trim() });
    } catch (err) {
      // The server's SENTENCE, not the wire shape: `ApiError.message` is
      // "POST /api/agents/scaffold → 409: {…}", which is a log line, not
      // something to show someone who just tried to name an agent.
      setError(errorMessage(err, `Couldn't create ${name}.`));
      setBusy(false);
      nameRef.current?.focus();
    }
  };

  return (
    <Dialog
      className="modal-confirm modal-create-agent"
      testId="create-agent-dialog"
      title="Create an agent"
      onClose={onCancel}
      onSubmit={() => void submit()}
      // Never dismissable mid-flight: the agent is being written to disk, and
      // pulling the dialog would leave the user with no report of how it went.
      dismissable={!busy}
      closeDisabled={busy}
      initialFocusRef={nameRef}
      /* Tagged `workspace` so before-send strips the project name a click
         inside this dialog would otherwise ship as $el_text, one analytics row
         per private project name (lib/analytics/before-send.ts,
         USER_NAMED_OBJECTS). */
      tracking={{ dialog: "create_agent", object: "workspace" }}
      /* NO `triggerRef`. Every door into this dialog is a control that unmounts
         when it is used — the project row's popover menu closes on click, the
         empty-project row is replaced by the agent it creates — so a ref handed
         in here would point at a detached node. */
      actions={
        <>
          <button className="btn-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn-primary modal-primary-cta"
            data-testid="create-agent-submit"
            disabled={!submittable}
            onClick={() => void submit()}
          >
            {busy ? "Creating…" : "Create agent"}
          </button>
        </>
      }
    >
      {/* The destination, stated. `title` carries the full path for a root
          long enough to ellipsize. */}
      <p className="modal-field-hint create-agent-target" title={projectRoot}>
        <span>
          In <strong data-testid="create-agent-project">{projectLabel}</strong>
        </span>
        <span className="create-agent-path">{projectRoot}</span>
      </p>

      <section className="modal-section">
        <label className="create-agent-label" htmlFor="create-agent-name">
          Name
        </label>
        <input
          id="create-agent-name"
          ref={nameRef}
          className="modal-input"
          data-testid="create-agent-name"
          value={name}
          spellCheck={false}
          autoComplete="off"
          placeholder="order-triage"
          disabled={busy}
          aria-invalid={nameRefusal != null}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
        />
        {/* Both refusals land HERE, under the field that produces them —
            the typed-name rule and the server's own sentence ("probes
            already has an agent called hello-world"), which was showing at
            the foot of the dialog, three fields away from the input the
            user has to change. */}
        {nameRefusal ? (
          <p className="modal-error" data-testid="create-agent-name-error">
            {nameRefusal}
          </p>
        ) : error ? (
          <p className="modal-error" data-testid="create-agent-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="modal-field-hint">
            It becomes a folder in {projectLabel}.
          </p>
        )}
      </section>

      <section className="modal-section">
        <span className="create-agent-label">Template</span>
        <div className="create-agent-templates" role="radiogroup" aria-label="Template">
          {templates.map((starter) => (
            <label
              key={starter.id}
              className="create-agent-template"
              data-testid={`create-agent-template-${starter.id}`}
              data-selected={starter.id === template ? "true" : undefined}
            >
              <input
                type="radio"
                name="create-agent-template"
                value={starter.id}
                checked={starter.id === template}
                disabled={busy}
                onChange={() => setTemplate(starter.id)}
              />
              <span className="create-agent-template-text">
                <span className="create-agent-template-name">{starter.name}</span>
                <span className="create-agent-template-desc">
                  {starter.description}
                </span>
              </span>
            </label>
          ))}
        </div>
        {onBrowseTemplates && (
          /* The gallery is a CLONE, not a scaffold: it forks a published
             template into a repo you own and needs an account. It is a
             different operation with a different failure mode, so it keeps
             its own journey rather than hiding behind this radio list. */
          <p className="modal-field-hint">
            <button
              type="button"
              className="create-agent-link"
              data-testid="create-agent-browse-templates"
              disabled={busy}
              onClick={onBrowseTemplates}
            >
              Browse the template gallery
            </button>{" "}
            to start from a published agent instead.
          </p>
        )}
      </section>

      <section className="modal-section">
        <label
          className="create-agent-label"
          htmlFor="create-agent-instruction"
        >
          First instruction <span className="create-agent-optional">optional</span>
        </label>
        <textarea
          id="create-agent-instruction"
          className="modal-input create-agent-instruction"
          data-testid="create-agent-instruction"
          rows={3}
          value={instruction}
          disabled={busy}
          placeholder="Triage inbound support email and route it to the right queue."
          onChange={(event) => setInstruction(event.target.value)}
        />
        <p className="modal-field-hint">
          The agent is created first; this is what the session starts on.
        </p>
      </section>
    </Dialog>
  );
}
