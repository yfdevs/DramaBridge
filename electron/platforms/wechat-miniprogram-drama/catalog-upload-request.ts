export type CatalogMaterialUploadParameters = {
  materialType: "DRAMA_COVER" | "EPISODE_VIDEO"
  episodeNo?: number
  slotNo?: number
}

export function catalogMaterialUploadUrl(
  baseUrl: string,
  dramaId: number,
  parameters: CatalogMaterialUploadParameters,
): URL {
  const url = new URL(
    `/admin/v1/dramas/${dramaId}/materials`,
    `${baseUrl.replace(/\/+$/, "")}/`,
  )
  url.searchParams.set("materialType", parameters.materialType)
  if (parameters.episodeNo !== undefined) {
    url.searchParams.set("episodeNo", String(parameters.episodeNo))
  }
  if (parameters.slotNo !== undefined) {
    url.searchParams.set("slotNo", String(parameters.slotNo))
  }
  return url
}
