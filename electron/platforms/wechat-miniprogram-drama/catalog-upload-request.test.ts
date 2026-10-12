import assert from "node:assert/strict"
import test from "node:test"

import { catalogMaterialUploadUrl } from "./catalog-upload-request"

test("places episode upload metadata in query parameters", () => {
  const url = catalogMaterialUploadUrl("https://example.com/", 765, {
    materialType: "EPISODE_VIDEO",
    episodeNo: 3,
  })

  assert.equal(url.pathname, "/admin/v1/dramas/765/materials")
  assert.equal(url.searchParams.get("materialType"), "EPISODE_VIDEO")
  assert.equal(url.searchParams.get("episodeNo"), "3")
  assert.equal(url.searchParams.has("slotNo"), false)
})

test("places cover upload metadata in query parameters", () => {
  const url = catalogMaterialUploadUrl("https://example.com", 773, {
    materialType: "DRAMA_COVER",
  })

  assert.equal(url.pathname, "/admin/v1/dramas/773/materials")
  assert.equal(url.searchParams.get("materialType"), "DRAMA_COVER")
  assert.equal(url.searchParams.has("slotNo"), false)
  assert.equal(url.searchParams.has("episodeNo"), false)
})
