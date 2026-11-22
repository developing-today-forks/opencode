import type { ModelInfo } from "@opencode/client"
import { createMemo, createSignal, Show } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DialogIntegration } from "./dialog-integration"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useData } from "../context/data"
import { modelPreferenceKey } from "../model-preference"
import { useLocation } from "../context/location"
import { useNewDesigns } from "../config"
import { isWildcardSearch, matchesWildcardSearch } from "./model-search"
import { DialogFreeModels } from "./dialog-model-free"
import { FavoriteMarker, isFreeModel, prioritizeFavorites, sortModelOptions } from "./model-options"

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const dialog = useDialog()
  const newDesigns = useNewDesigns()
  const connected = useConnected()

  function select(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.current()
    if (cur && list.includes(cur)) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  function connect() {
    dialog.replace(() => (
      <DialogIntegration onConnected={(providerID) => dialog.replace(() => <DialogModel providerID={providerID} />)} />
    ))
  }

  return (
    <Show
      when={newDesigns() && !connected() && !props.providerID}
      fallback={<DialogConnectedModels providerID={props.providerID} onSelect={select} onConnect={connect} />}
    >
      <DialogFreeModels onSelect={select} onConnect={connect} />
    </Show>
  )
}

function DialogConnectedModels(props: {
  providerID?: string
  onSelect: (providerID: string, modelID: string) => void
  onConnect: () => void
}) {
  const local = useLocal()
  const newDesigns = useNewDesigns()
  const data = useData()
  const location = useLocation()
  const [query, setQuery] = createSignal("")
  // Under new designs, favoriting does not reorder the list until the dialog is reopened.
  const favoritesAtOpen = [...local.model.favorite()]
  const favoritePriority = new Set(favoritesAtOpen.map(modelPreferenceKey))
  const isFavorite = (value: { providerID: string; modelID: string } | undefined) =>
    value !== undefined &&
    local.model.favorite().some((item) => item.providerID === value.providerID && item.modelID === value.modelID)
  // Under new designs the detail row shows the price, so the trailing slot only marks favorites.
  const trailing = (model: ModelInfo, favorite: boolean) => {
    if (newDesigns()) return favorite ? <FavoriteMarker /> : undefined
    return isFreeModel(model) ? "Free" : undefined
  }
  // OpenCode's own free models get their own group at the end of the list instead of joining "OpenCode".
  const freeGroup = (model: ModelInfo) =>
    newDesigns() && !props.providerID && model.providerID === "opencode" && isFreeModel(model)

  const connected = useConnected()
  const providers = createMemo(
    () => new Map((data.location.provider.list(location.ref) ?? []).map((item) => [item.id, item])),
  )
  const models = createMemo(() => data.location.model.list(location.ref) ?? [])

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? (newDesigns() ? favoritesAtOpen : local.model.favorite()) : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const model = models().find((model) => model.providerID === item.providerID && model.id === item.modelID)
        if (!model) return []
        const provider = providers().get(model.providerID)
        return [
          {
            key: item,
            value: { providerID: model.providerID, modelID: model.id },
            title: model.name,
            releaseDate: model.time.released,
            description: provider?.name ?? model.providerID,
            category,
            footer: trailing(model, isFavorite(item)),
            onSelect: () => {
              props.onSelect(model.providerID, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = toOptions(favorites, "Favorites")
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const modelOptions = sortModelOptions(
      models()
        .filter((model) => model.status !== "deprecated")
        .filter((model) => (props.providerID ? model.providerID === props.providerID : true))
        // Hidden models (#230) are absent from the picker unless the search is
        // the model's exact full name or a matching wildcard pattern;
        // favorites/recents above are explicit user choices and keep working.
        .filter((model) => {
          if (!model.hidden) return true
          const search = needle.toLowerCase()
          if (!search) return false
          const provider = providers().get(model.providerID)
          const values = [
            model.name,
            String(model.id),
            `${model.providerID}/${model.id}`,
            `${provider?.name ?? model.providerID}/${model.name}`,
          ]
          return values.map((value) => value.toLowerCase()).includes(search) || matchesWildcardSearch(needle, values)
        })
        .map((model) => {
          const provider = providers().get(model.providerID)
          const value = { providerID: model.providerID, modelID: model.id }
          const favorite = isFavorite(value)
          return {
            value,
            providerID: model.providerID,
            providerName: provider?.name ?? model.providerID,
            // The full reference is a fuzzy key too (#230): an exact-name search
            // for a hidden model (`provider/model`) must survive this stage,
            // not just the hidden filter above.
            reference: `${model.providerID}/${model.id}`,
            qualifiedName: `${provider?.name ?? model.providerID}/${model.name}`,
            title: model.name,
            releaseDate: model.time.released,
            description: newDesigns() ? undefined : favorite ? "(Favorite)" : undefined,
            category: connected() ? (freeGroup(model) ? "Free" : (provider?.name ?? model.providerID)) : undefined,
            footer: trailing(model, favorite),
            free: isFreeModel(model),
            onSelect() {
              props.onSelect(model.providerID, model.id)
            },
          }
        })
        .filter((option) => {
          if (!showSections) return true
          if (
            favorites.some(
              (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
            )
          )
            return false
          if (
            recents.some((item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID)
          )
            return false
          return true
        }),
      connected(),
    )

    if (needle) {
      // Wildcard searches (#230) match with the shared glob rule instead of
      // fuzzysort, so app and TUI pickers return the same results.
      const matched = isWildcardSearch(needle)
        ? modelOptions.filter((option) =>
            matchesWildcardSearch(needle, [option.title, option.reference, option.qualifiedName]),
          )
        : fuzzysort
            .go(needle, modelOptions, { keys: ["title", "category", "reference", "qualifiedName"] })
            .map((item) => item.obj)
      const results = prioritizeFavorites(sortModelOptions(matched, false), favoritePriority)
      // Search results name the provider inline. Without a category, the trailing slot keeps the favorite marker
      // instead of falling back to the provider name.
      if (!newDesigns()) return results
      return results.map((option) => ({ ...option, description: option.providerName, category: undefined }))
    }

    if (!connected()) return prioritizeFavorites(modelOptions, favoritePriority)

    return [
      ...favoriteOptions,
      ...recentOptions,
      ...modelOptions.filter((option) => option.category !== "Free"),
      ...modelOptions.filter((option) => option.category === "Free"),
    ]
  })

  const provider = createMemo(() => (props.providerID ? providers().get(props.providerID) : undefined))

  const title = createMemo(() => {
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      searchInTitle
      titlePlaceholder="Search models"
      options={options()}
      actions={[
        {
          command: "model.dialog.provider",
          title: newDesigns()
            ? connected()
              ? "connect integration"
              : "view all integrations"
            : connected()
              ? "Connect an integration"
              : "View all integrations",
          selection: "none",
          onTrigger: props.onConnect,
        },
        {
          command: "model.dialog.favorite",
          title: newDesigns() ? (option) => (isFavorite(option?.value) ? "unfavorite" : "favorite") : "Favorite",
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}
