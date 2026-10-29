# Third-party notices

## FlyBody visual body model

This site includes a browser-optimized derivative of the visual meshes from
[`TuragaLab/flybody`](https://github.com/TuragaLab/flybody), commit
`d015e9bfe441bd90ae431bac24c55cb74bdbce26`.

FlyBody was developed through a collaboration between Google DeepMind and the
HHMI Janelia Research Campus. The upstream project is licensed under the Apache
License, Version 2.0. A copy is distributed at
`licenses/flybody-APACHE-2.0.txt` (relative to the application directory).

Changes made for this site: the official OBJ visual meshes were transformed
according to the upstream MuJoCo `fruitfly.xml` hierarchy, simplified with a
vertex-clustering web LOD process, assigned equivalent display materials, and
packaged as one binary glTF asset. The original MuJoCo collision geometry,
dynamics, actuators and policies are not contained in this display asset.

## fly-brain connectome, neuron positions, and LIF model

This site includes the compressed 165,122-neuron soma table, the 10,511,038-edge
connectome, neuron annotations and physiology tables, FlyVis-to-CNS mapping,
calibrated parameter file, and JavaScript LIF/codec modules from
[`Lulzx/fly-brain`](https://github.com/Lulzx/fly-brain),
commit `ba0b4f815c00e81a2ef1f36165df2b1891e5e39c`.

The upstream project is licensed under the MIT License. A copy is distributed
at `licenses/fly-brain-MIT.txt` (relative to the application directory).

The soma coordinates and graph weights are upstream anatomical data. The CNS
worker computes LIF spikes from those weights and receives visual drive from
FlyVis through the upstream mapping. Body motion now reads filtered firing of
identified descending neurons (steering, forward, takeoff and flight). Annotated
wing-power motor neurons are monitored, but are not used as a flight command.
The cell roles, steering weights and filtering follow
fly-brain's motor readout; the conversion into motion of this site's visual
FlyBody is an experimental, site-specific proxy. A bounded endogenous forward
drive and optional takeoff / flight-DN and wing-MN inhibition stimuli enter the LIF network,
not the body. The odor field, antennal/wind sampling, and sensory-to-navigation
adapter are site-specific approximations with hand-designed drive rules.
Validated olfactory sensorimotor circuitry, neuromodulation, the full FlyBody
MuJoCo dynamics, and a validated wing motor controller remain absent. In upstream fly-brain the
wing motor pools do not reliably encode takeoff or steering, so this site does
not claim a biologically validated flight controller. Neural model time can
run slower than the rendered body's time.

## FlyVis pretrained optic-lobe model

This site includes the `flow/0000/000` FlyVis model export (`45,669` nodes and
`1,513,231` connections per eye) from [`Lulzx/fly-brain`](https://github.com/Lulzx/fly-brain),
commit `ba0b4f815c00e81a2ef1f36165df2b1891e5e39c`. The model originates
from [`TuragaLab/flyvis`](https://github.com/TuragaLab/flyvis), Lappalainen et al.
(2024). The export and browser rate-network step follow the upstream MIT
licensed implementation; see `licenses/fly-brain-MIT.txt` in the application directory.

The site renders two head-mounted perspective images from its Three.js scene,
samples 721 luminance columns per eye, and advances two independent model
states in a Web Worker. Their mapped visual activity enters the whole-CNS LIF
worker. T4/T5 direction-channel differences remain visual diagnostics and do
not directly drive the body. The on-screen CNS link switch disconnects motor
readout from the display body while both neural networks keep running.
