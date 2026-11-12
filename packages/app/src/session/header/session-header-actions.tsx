import { Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useSessionLayout } from "@/session/session-layout"
import { Session } from "@opencode/schema/session"

export function SessionReviewToggle(props: { usage?: Session.AuthoritativeUsage }) {
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
      usage={props.usage}
    />
  )
}

export type SessionHeaderActionsState = {
  reviewLabel: string
  reviewKeybind: string[]
  reviewVisible: boolean
  reviewOpened: boolean
  onReviewToggle: () => void
}

export function SessionHeaderActions(props: { state: SessionHeaderActionsState; usage?: Session.AuthoritativeUsage }) {
  return (
    <div class="flex items-center gap-2">
      <Show when={props.usage}>
        {(usage) => (
          <Tooltip
            class="shrink-0"
            placement="bottom"
            value={
              <div class="flex flex-col gap-1">
                <div>Total cost: {formatUsageCost(usage().cost)}</div>
                <div>Cache savings: {formatUsageCost(usage().cacheSavings)}</div>
                <div>Input tokens: {usage().tokens.input.toLocaleString()}</div>
                <div>Output tokens: {usage().tokens.output.toLocaleString()}</div>
                <div>Reasoning tokens: {usage().tokens.reasoning.toLocaleString()}</div>
                <div>Cache read tokens: {usage().tokens.cache.read.toLocaleString()}</div>
                <div>Cache write tokens: {usage().tokens.cache.write.toLocaleString()}</div>
              </div>
            }
          >
            <span class="text-12-regular text-text-weak tabular-nums">{formatHeaderCost(usage().cost)}</span>
          </Tooltip>
        )}
      </Show>
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

const formatHeaderCost = (cost: number) => (cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`)
const formatUsageCost = (cost: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(cost)
