# Third-party notices

Facility AI Twin's new code is provided under Apache-2.0. Third-party assets retain their original licenses.

| Component | Source | License / local copy |
|---|---|---|
| Physics adapter and MJCF parsing | Existing fly-brain-lab / CONNECT AI LAB project, fly-bodies/src/bodies/mjcf-body.js, engine.js, mjcf.js | Apache-2.0, LICENSES/Apache-2.0.txt |
| Unitree Go1 model and meshes | MuJoCo Menagerie, unitree_go1, originally Unitree Robotics; copied from local fly-brain-lab assets | BSD-3-Clause, LICENSES/unitree_go1-BSD-3.txt |
| Go1 locomotion ONNX policy | Google DeepMind MuJoCo Playground; copied from local fly-brain-lab public/policies/go1_policy.onnx | Apache-2.0, LICENSES/Apache-2.0.txt |
| MuJoCo | google-deepmind/mujoco, @mujoco/mujoco 3.11.0 | Apache-2.0, LICENSES/mujoco-Apache-2.0.txt |
| ONNX Runtime Web | Microsoft, onnxruntime-web 1.27.0 | MIT, LICENSES/onnxruntime-web-MIT.txt |
| Three.js and addons | mrdoob/three.js, 0.164.1 | MIT, LICENSES/three-MIT.txt |
| Pretendard Variable font | orioncactus/pretendard, Gil Hyung-jin | SIL OFL 1.1, LICENSES/Pretendard-OFL.txt |
| Vite and installed transitive dependencies | npm packages identified by package-lock.json | Licenses distributed with the respective packages |
| Hermes adapter | Invokes the locally installed Hermes CLI Python modules; Hermes is not bundled | Retains installed Hermes license and user configuration |

Adapter modifications in this project: changed local import/asset paths, facility spawn pose reset, movable obstruction, new facility MJCF environment, actual policy state reporting and controlled execution from the simulation UI. This project did not train the bundled Go1 policy.

The facility geometry, lightweight robot, UI, decision schema and incident simulation are authored for this prototype. ICTWAY is referenced as the prospective collaboration context. Its logo, proprietary models, private platform data and code are not bundled. No partnership or endorsement is implied.
