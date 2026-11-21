import unittest
from urllib.parse import quote
from materials import material_filenames, verify_materials


def item(filename):
    return "material.library.item.hash%2Cuuid."+quote(filename)+".apply"


class MaterialVerificationTests(unittest.TestCase):
    def test_encoded_names_and_dotted_filenames(self):
        names = ["第01集-片段-001.mp4", "episode.01.mp4", "100%20.mp4"]
        self.assertEqual(material_filenames([item(name) for name in names]+["unrelated"]),names)

    def test_complete_batch_never_searches(self):
        result = verify_materials(["a.mp4","b.mp4"],lambda:[item("a.mp4"),item("b.mp4")],lambda _:None)
        self.assertEqual(result,{"verifiedMaterials":2,"batchVerified":2,"searchedMaterials":0})

    def test_unlisted_materials_fail_without_search(self):
        with self.assertRaisesRegex(RuntimeError,"未执行文字搜索"):
            verify_materials(["a.mp4","b.mp4"],lambda:[item("a.mp4")],lambda _:None,timeout=0)

    def test_ambiguous_names_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError,"同名文件"):
            verify_materials(["a.mp4","a.mp4"],lambda:[],lambda _:None)
        with self.assertRaisesRegex(RuntimeError,"同名重复记录"):
            verify_materials(["a.mp4"],lambda:[item("a.mp4"),item("a.mp4")],lambda _:None)


if __name__ == "__main__":
    unittest.main()
