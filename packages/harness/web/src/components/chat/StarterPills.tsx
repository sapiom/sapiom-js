import type { JSX } from "react";

/**
 * Contextual starter prompts — one wrapping row of flat pills that submit
 * their text as a real turn. Rendered in two places: under the chat empty
 * state's body, and above the composer once a turn settles. The prompts
 * follow the demo workspace's actual arc (map → local run → explain a
 * step), so every pill leads somewhere real.
 */
export const STARTER_PROMPTS = [
  "Map the workflow",
  "Run a local test",
  "Explain the approve step",
] as const;

export const StarterPills = ({ onPick }: { onPick: (text: string) => void }): JSX.Element => (
  <div className="chat-starters" data-testid="chat-starters">
    {STARTER_PROMPTS.map((prompt) => (
      <button
        key={prompt}
        type="button"
        className="chat-starter"
        data-testid="chat-starter"
        onClick={() => onPick(prompt)}
      >
        {prompt}
      </button>
    ))}
  </div>
);
