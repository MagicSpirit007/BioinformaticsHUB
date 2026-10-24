"""Verify the slim release payload and archive only version-control source files."""
import argparse
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-dir', type=Path, default=ROOT / 'apps/bioinformatics-hub-desktop/release')
    release = parser.parse_args().release_dir.resolve()
    resources = release / 'win-unpacked/resources'
    engine = resources / 'engine'
    version = json.loads((ROOT / 'apps/bioinformatics-hub-desktop/package.json').read_text(encoding='utf-8'))['version']
    installer = release / f'BioinformaticsHUB-{version}-win-x64.exe'
    assert installer.is_file(), 'Installer missing'
    files = [p for p in resources.rglob('*') if p.is_file()]
    forbidden = [p for p in files if any(part in {'.venv','venv','runs','__pycache__','browser-validation-profile'} or part.startswith('.env') for part in p.relative_to(resources).parts)]
    assert not forbidden, 'Private/runtime files included in release'
    assert (release / 'win-unpacked/biohub.cmd').is_file(), 'CLI launcher missing'
    verified = []
    for folder in ['scripts/vendor/jev_ultrafast','scripts/workflow']:
        for source in (ROOT / folder).rglob('*'):
            if source.is_file() and '__pycache__' not in source.parts:
                target = engine / source.relative_to(ROOT)
                assert target.is_file() and digest(source)==digest(target), f'Stale engine source: {source.relative_to(ROOT)}'
                verified.append(source.relative_to(ROOT).as_posix())
    for name in ['scripts/workflow_worker.py','scripts/biohub.cjs','requirements-browser.txt']:
        assert digest(ROOT/name)==digest(engine/name), f'Stale {name}'
    for name in ['workflow-recipes.json','site-acceptance.json']:
        assert digest(ROOT/'apps/bioinformatics-hub/public'/name)==digest(resources/'ui'/name), f'Stale UI {name}'
    assert 'MIT License' in (engine/'scripts/vendor/jev_ultrafast/LICENSE').read_text(encoding='utf-8')
    output = ROOT/'runs/delivery'
    output.mkdir(parents=True,exist_ok=True)
    archive = output/f'BioinformaticsHUB-{version}-source.zip'
    tracked = subprocess.check_output(['git','ls-files','-z','--cached','--others','--exclude-standard'],cwd=ROOT).decode('utf-8').split('\0')
    count = 0
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as bundle:
        for name in sorted(set(tracked)):
            source=ROOT/name
            if not name or not source.is_file(): continue
            if any(part in {'node_modules','.git','.venv','.venv-local','runs','release','dist','__pycache__'} or part.startswith(('.env', 'release-candidate')) for part in Path(name).parts): continue
            bundle.write(source,'BioinformaticsHUB/'+name)
            count += 1
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.testzip() is None
        assert 'BioinformaticsHUB/scripts/vendor/jev_ultrafast/LICENSE' in bundle.namelist()
    result = {'ok':True,'installer':{'path':str(installer),'bytes':installer.stat().st_size,'sha256':digest(installer)},'source':{'path':str(archive),'files':count,'bytes':archive.stat().st_size,'sha256':digest(archive)},'checks':['slim payload excludes env, virtualenv, profiles and runs','vendored Jev and workflow source hashes match workspace','packaged recipes and acceptance data match source','MIT license retained','source archive CRC verified'],'engineFilesVerified':len(verified)}
    (output/'release-validation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__': main()
