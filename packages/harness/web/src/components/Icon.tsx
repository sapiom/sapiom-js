import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  Cloud,
  CloudOff,
  Code,
  Copy,
  CornerDownRight,
  CornerLeftUp,
  ExternalLink,
  FlaskConical,
  Folder,
  GitBranch,
  FolderOpen,
  FolderPlus,
  Frame,
  Globe,
  Hammer,
  HelpCircle,
  History,
  ImageUp,
  Info,
  LayoutTemplate,
  List,
  ListChecks,
  Loader,
  LogOut,
  type LucideIcon,
  Maximize2,
  Menu,
  MessageSquare,
  Minimize2,
  Minus,
  EllipsisVertical,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pencil,
  Play,
  Plug,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareTerminal,
  Sun,
  Tags,
  Trash2,
  TriangleAlert,
  Wand2,
  Workflow,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
  CloudUpload,
} from "lucide-react";
import type { JSX } from "react";

/**
 * A curated map, not a barrel import of the whole icon set — keeps the bundle
 * tree-shakeable. MacroDef.icon is still free-form config; unknown names
 * fall back to HelpCircle rather than failing to render.
 */
export const ICON_REGISTRY = {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  Cloud,
  CloudOff,
  CloudUpload,
  Code,
  Copy,
  CornerDownRight,
  CornerLeftUp,
  ExternalLink,
  FlaskConical,
  Folder,
  GitBranch,
  FolderOpen,
  FolderPlus,
  Frame,
  Globe,
  Hammer,
  History,
  ImageUp,
  Info,
  LayoutTemplate,
  List,
  ListChecks,
  Loader,
  LogOut,
  Maximize2,
  Menu,
  MessageSquare,
  Minimize2,
  Minus,
  /* OVERFLOW MENUS: ONE GLYPH, VERTICAL. There is no second one to pick.

     This app shipped both, with no rule — horizontal in the rail header and the
     canvas action bar, vertical on the plan card. The first attempt at fixing it
     wrote the accident down as a convention ("horizontal for bars, vertical for
     rows"); that IS a real convention elsewhere, but it was never the reason
     these three differed, and it left a reader doing a classification exercise
     every time they add a menu. Two glyphs for one meaning is a cost with no
     payer.

     Vertical is the one kept, because a HORIZONTAL ellipsis already means
     something else here: elision. It is what a clipped agent name, an elided
     directory chain and every `text-overflow` in the rail render. A control
     shaped like the app's own truncation marker is the worse of the two.

     Registered under lucide's CANONICAL name, not the deprecated `MoreVertical`
     alias, so the name here matches the `lucide-ellipsis-vertical` class it
     renders. The alias does not name its own output — a spec asserting
     `lucide-more-horizontal` was wrong for exactly that reason.

     `MoreHorizontal` is deliberately absent. That is what makes this a rule and
     not a preference: reaching for it no longer compiles. */
  EllipsisVertical,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pencil,
  Play,
  Plug,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareTerminal,
  Sun,
  Tags,
  Trash2,
  TriangleAlert,
  Wand2,
  Workflow,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} satisfies Record<string, LucideIcon>;

/**
 * `satisfies`, NOT an annotation. `Record<string, LucideIcon>` widens
 * `keyof typeof ICON_REGISTRY` to `string`, so ANY name typechecked, fell
 * through to the HelpCircle fallback, and put a question mark on screen where a
 * real glyph belonged — a status the app was not actually reporting. This
 * branch shipped that twice: `GitBranch` on a new note row, and
 * `EllipsisVertical` moments after being wired up. `satisfies` still checks the
 * values, and now fixes the keys too.
 *
 * `Icon`'s own `name` stays `string` DELIBERATELY. Palette entries, macro
 * actions and toasts carry icon names through config typed as `string`, and
 * narrowing the prop cascades into every one of those shapes — a refactor with
 * its own risk, for a class of bug a test can catch outright. So the runtime
 * fallback stays too (a bad name must never blank a row), and
 * `icon-registry.test.ts` asserts that every literal `<Icon name="…">` in the
 * source is registered. That test is what found `Minus`, which had been
 * rendering a question mark in the step inspector.
 */
export type IconName = keyof typeof ICON_REGISTRY;

export function Icon({ name, size = 16 }: { name: string; size?: number }): JSX.Element {
  const Component = ICON_REGISTRY[name as IconName] ?? HelpCircle;
  return <Component size={size} strokeWidth={1.75} aria-hidden="true" />;
}
