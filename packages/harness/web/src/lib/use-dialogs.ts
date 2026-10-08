/**
 * The shell's destinations and cards on top: what stands in for the centre
 * (the new-agent screen, a past session under review, Templates, the Overview)
 * and what opens over it (the palette, the folder step, a clone confirm, the
 * Remove-from-the-rail confirm, settings). Held together because every door
 * that points the centre somewhere clears the destinations at once
 * (`leaveDestinations`).
 */
import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@shared/types";
import type { StudioProjectId } from "@sapiom/agent-map";

import type { ProjectFolderIntent } from "../components/ProjectFolderDialog";
import type { DeepLinkAgentTarget } from "./desktop";
import type { StudioTemplate } from "./templates";

/** Where the new-agent screen is creating, as the rail labels it. */
export interface ComposerProject {
  root: string;
  label: string;
  /** The durable Studio project id, when the server has minted one. */
  projectId: StudioProjectId | null;
  /** The template the screen opens with as its idea, if Use brought us here. */
  template: StudioTemplate | null;
  /** Which template surface Use was pressed on; the product metric names it. */
  templateSurface?: "welcome" | "template_gallery" | "template_detail";
}

export interface FolderPrompt {
  intent: ProjectFolderIntent;
  template: StudioTemplate | null;
  /** The control that ran the step, so Escape hands focus back to it. */
  trigger: HTMLElement | null;
}

export const useDialogs = () => {
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The composer-first "new session" home. `composing` holds it open for
  // explicit Create-new intent or a submission from the automatic home.
  // The home also shows whenever nothing else claims the centre pane.
  const [composing, setComposing] = useState(false);
  /**
   * THE PROJECT THE NEW-AGENT SCREEN IS CREATING IN (flow-creation.md §4.3).
   *
   * Both entrances set it: New project after its folder step, and a project
   * row's New agent. The screen STATES it, never asks for it; the folder was
   * chosen before the screen opened. A template carried here is the idea the
   * screen opens with (template Use routes through this screen, CF-D11).
   */
  const [composerProject, setComposerProject] = useState<ComposerProject | null>(
    null,
  );
  // The stated project lives exactly as long as the scoped screen does. Every
  // exit (submit, Back, opening a session or a map) ends with `composing`
  // false, and the automatic home that may show afterwards must not inherit a
  // project nobody chose for it: its submit would create there.
  useEffect(() => {
    if (!composing) setComposerProject(null);
  }, [composing]);
  /**
   * The web half of the folder step, while it is open. Desktop never sets it:
   * the bridge's `chooseDirectory` answers the question directly (D29). What
   * happens after the folder is the intent's: New project continues to the
   * new-agent screen, Add project stops once the folder is in the rail.
   */
  const [folderPrompt, setFolderPrompt] = useState<FolderPrompt | null>(null);
  /** The project whose Remove-from-the-rail confirm is open (the map
   *  header's ×), and the control focus returns to when it closes. */
  const [removing, setRemoving] = useState<{ root: string; label: string } | null>(
    null,
  );
  const removeTriggerRef = useRef<HTMLButtonElement | null>(null);
  // The remote-only agent a deep link is offering to clone (drives the confirm).
  const [cloneRequest, setCloneRequest] = useState<DeepLinkAgentTarget | null>(
    null,
  );
  // A template a deep link asked to open (`sapiom://templates/<id>`): the id is
  // handed to the templates browser, which resolves it against the live catalog
  // and opens its detail. Null when no template deep link is pending.
  const [deepLinkTemplateId, setDeepLinkTemplateId] = useState<string | null>(
    null,
  );
  // Lifted so the telemetry chip in the session bar can open the settings
  // popover from outside SessionBar's own gear button.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // A PAST session under review: picked from the history menu, shown
  // in the terminal slot as a review pane — resuming/starting is the pane's
  // explicit action, never a side effect of the click that got here.
  const [reviewSummary, setReviewSummary] = useState<SessionSummary | null>(
    null,
  );
  // Template gallery opened from the command palette (browse is reachable
  // from anywhere, not only the add dialog / welcome panel entries).
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // The Overview: an introduction to the app, opened from the account menu's
  // "Overview" item. A full-width destination like Templates (never the
  // composer it used to alias), cleared by any navigation the same way.
  const [overviewOpen, setOverviewOpen] = useState(false);

  /** Every door that points the centre somewhere clears the destinations that
   *  stand in for it, so a click behind an open Templates view is never lost. */
  const leaveDestinations = (): void => {
    setComposing(false);
    setReviewSummary(null);
    setTemplatesOpen(false);
    setOverviewOpen(false);
  };

  return {
    paletteOpen,
    setPaletteOpen,
    composing,
    setComposing,
    composerProject,
    setComposerProject,
    folderPrompt,
    setFolderPrompt,
    removing,
    setRemoving,
    removeTriggerRef,
    cloneRequest,
    setCloneRequest,
    deepLinkTemplateId,
    setDeepLinkTemplateId,
    settingsOpen,
    setSettingsOpen,
    reviewSummary,
    setReviewSummary,
    templatesOpen,
    setTemplatesOpen,
    overviewOpen,
    setOverviewOpen,
    leaveDestinations,
  };
};

export type Dialogs = ReturnType<typeof useDialogs>;
