import { Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useSessionLayout } from "@/session/session-layout"

export function SessionReviewToggle() {
  const command = useCommand()
  const language = useLanguage()
  const { view } = useSessionLayout()

  return (
    <SessionHeaderActions
      state={{
        reviewLabel: language.t("command.review.toggle"),
        reviewKeybind: command.keybindParts("review.toggle"),
        reviewVisible: true,
        reviewOpened: view().side.opened(),
        onReviewToggle: () => view().side.toggle(),
      }}
    />
  )
}

export type SessionCostState = {
  cost: number
  cacheSavings: number
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}

/** Packet B (#7): under a cent shows as <$0.01; anything else is $X.XX. Zero is $0.00. */
export const formatSessionCost = (cost: number) => (cost > 0 && cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`)

/**
 * The session's authoritative cost (success-only route_attempt totals from
 * Session.Info.costAuthoritative) in the header-adjacent control row. The
 * projector-based Info.cost is a different accounting and is never shown here.
 * Tooltip carries only stored authoritative values: total, cache savings, and
 * token counts by kind — route_attempt stores no per-kind dollar split.
 */
export function SessionCostChip(props: { cost: SessionCostState | undefined }) {
  const tokens = () => props.cost?.tokens

  return (
    <Show when={props.cost}>
      {(cost) => (
        <Tooltip
          class="shrink-0"
          placement="bottom"
          value={
            <div class="flex flex-col gap-0.5">
              <span>Session cost (authoritative): {formatSessionCost(cost().cost)}</span>
              <span>Cache savings: {formatSessionCost(cost().cacheSavings)}</span>
              <span>
                Tokens: {tokens()?.input.toLocaleString()} in · {tokens()?.output.toLocaleString()} out ·{" "}
                {tokens()?.reasoning.toLocaleString()} reasoning · {tokens()?.cache.read.toLocaleString()} cache
                read · {tokens()?.cache.write.toLocaleString()} cache write
              </span>
            </div>
          }
        >
          <span
            class="shrink-0 px-2 text-sm tabular-nums text-[var(--v2-text-text-secondary)]"
            aria-label={`Session cost (authoritative): ${formatSessionCost(cost().cost)}`}
          >
            {formatSessionCost(cost().cost)}
          </span>
        </Tooltip>
      )}
    </Show>
  )
}

export type SessionHeaderActionsState = {
  reviewLabel: string
  reviewKeybind: string[]
  reviewVisible: boolean
  reviewOpened: boolean
  onReviewToggle: () => void
}

export function SessionHeaderActions(props: { state: SessionHeaderActionsState }) {
  return (
    <div class="flex items-center gap-2">
      <Show when={props.state.reviewVisible}>
        <Tooltip
          class="shrink-0"
          placement="bottom"
          value={
            <>
              {props.state.reviewLabel}
              <Show when={props.state.reviewKeybind.length > 0}>
                <Keybind keys={props.state.reviewKeybind} variant="neutral" />
              </Show>
            </>
          }
        >
          <IconButton
            type="button"
            variant="ghost-muted"
            size="large"
            class="shrink-0"
            style={{
              // This fixed control sits above moving panel contents.
              "--v2-overlay-simple-overlay-hover": "var(--v2-background-bg-layer-01)",
              "--v2-overlay-simple-overlay-pressed": "var(--v2-background-bg-layer-02)",
            }}
            state={props.state.reviewOpened ? "pressed" : undefined}
            onClick={props.state.onReviewToggle}
            aria-label={props.state.reviewLabel}
            aria-expanded={props.state.reviewOpened}
            aria-controls="review-panel"
            icon={<Icon name="sidebar-right" />}
          />
        </Tooltip>
      </Show>
    </div>
  )
}
