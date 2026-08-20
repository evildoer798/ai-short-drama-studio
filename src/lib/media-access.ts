export function resolveMediaProjectId(media: {
  images?: Array<{ asset: { projectId: string } }>
  storyboardVideos?: Array<{ storyboard: { projectId: string } }>
  storyboardVideoTailFrames?: Array<{ storyboard: { projectId: string } }>
  projectRenders?: Array<{ projectId: string }>
  directorImageVersions?: Array<{ keyframe: { production: { projectId: string } } }>
  directorVideoVersions?: Array<{ shot: { production: { projectId: string } } }>
  directorStateImageVersions?: Array<{ stateAsset: { production: { projectId: string } } }>
} | null | undefined) {
  return media?.images?.[0]?.asset.projectId
    || media?.storyboardVideos?.[0]?.storyboard.projectId
    || media?.storyboardVideoTailFrames?.[0]?.storyboard.projectId
    || media?.projectRenders?.[0]?.projectId
    || media?.directorImageVersions?.[0]?.keyframe.production.projectId
    || media?.directorVideoVersions?.[0]?.shot.production.projectId
    || media?.directorStateImageVersions?.[0]?.stateAsset.production.projectId
    || null
}
