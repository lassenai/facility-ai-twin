import { FACILITY } from './facility.js';
import { FINDINGS } from './inspection.js';
import { photoAgentName } from './inspection-photo.js';

export function mountPhotoViewer({ getPhoto }) {
  const $ = id => document.getElementById(id);
  let shown = null;
  const dialog = $('photoDialog');
  function open() {
    const photo = getPhoto(); if (!photo?.image) return;
    const asset = FACILITY.assets.find(a => a.id === photo.snapshot.targetId);
    $('photoDialogTitle').textContent = asset.id + ' · ' + asset.name + ' 현장 사진';
    $('photoDialogImage').src = photo.image.dataUrl;
    $('photoDialogImage').alt = asset.name + ' · ' + FINDINGS[photo.snapshot.finding] + ' · 가상 점검 이미지';
    $('photoDialogCaption').textContent = 'Agent ' + photoAgentName(photo.snapshot.agentMode) + ' · ' + FINDINGS[photo.snapshot.finding] + ' · ' + photo.snapshot.runId + ' · 촬영 시 합성 관측';
    $('photoDialogDownload').href = photo.image.dataUrl;
    $('photoDialogDownload').download = 'Go1-' + asset.id + '-' + photo.snapshot.runId + '.jpg';
    dialog.showModal();
  }
  $('agentPhoto').onclick = $('inspectionPhotoOpen').onclick = open;
  $('photoDialogClose').onclick = () => dialog.close();
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  function sync() {
    const photo = getPhoto(), available = Boolean(photo?.image);
    $('agentPhoto').hidden = !available;
    if (!available) { shown = null; if (dialog.open) dialog.close(); return; }
    if (shown === photo.image.dataUrl) return;
    shown = photo.image.dataUrl;
    $('agentPhotoImage').src = shown;
    $('agentPhotoImage').alt = photo.snapshot.targetId + ' 가상 점검 사진';
    $('agentPhotoFinding').textContent = photo.snapshot.targetId + ' · ' + FINDINGS[photo.snapshot.finding];
    $('agentPhoto').setAttribute('aria-label', photo.snapshot.targetId + ' 현장 사진 크게 보기');
  }
  return { sync };
}
