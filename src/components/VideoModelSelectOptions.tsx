import {
  groupVideoModelOptions,
  type PresentableVideoModel,
  videoModelOptionText,
} from '@/lib/video-model-presentation'

export function VideoModelSelectOptions({
  models,
  unavailableLabel,
}: {
  models: PresentableVideoModel[]
  unavailableLabel?: string
}) {
  return groupVideoModelOptions(models).map((group) => (
    <optgroup key={group.id} label={group.label}>
      {group.models.map((model) => (
        <option key={model.id} value={model.id} disabled={model.available === false}>
          {videoModelOptionText(model, unavailableLabel)}
        </option>
      ))}
    </optgroup>
  ))
}
