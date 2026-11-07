param([Parameter(Mandatory=$true)][string]$VmHome, [ValidateRange(1,32)][int]$Cpus=4, [ValidateRange(2048,65536)][int]$MemoryMiB=8192)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$vmDir = [IO.Path]::GetFullPath($VmHome)
if ($vmDir.Contains(',')) { throw 'VM path cannot contain commas' }
$qemu = (Get-Command qemu-system-x86_64.exe).Source
$qemuImg = (Get-Command qemu-img.exe).Source
if ((& $qemu -accel help) -notcontains 'whpx') { throw 'WHPX is unavailable; enable it explicitly. No software fallback.' }
if (((& $qemu --version) -join "`n") -ne [IO.File]::ReadAllText("$vmDir/qemu-version.txt")) { throw 'QEMU version changed; verify the new installation before updating the recorded version' }
$binaryRecord = Get-Content -Raw "$vmDir/qemu-binaries.json" | ConvertFrom-Json
if ((Get-FileHash $qemu -Algorithm SHA256).Hash -ne $binaryRecord.systemSha256 -or (Get-FileHash $qemuImg -Algorithm SHA256).Hash -ne $binaryRecord.imageSha256) { throw 'Installed QEMU binaries changed; review before updating their recorded hashes' }
$lock = [IO.File]::Open("$vmDir/qemu.lock", [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  foreach ($name in @('os.qcow2','data.qcow2')) {
    & $qemuImg check -f qcow2 "$vmDir/$name"
    if ($LASTEXITCODE -ne 0) { throw "Disk check failed: $name" }
  }
  $qemuArgs = @('-accel','whpx','-machine','pc','-smp',"cores=$Cpus",'-m',"$MemoryMiB",'-drive',"file=$vmDir/os.qcow2,if=virtio,format=qcow2",'-drive',"file=$vmDir/data.qcow2,if=none,id=agentdata,format=qcow2",'-device','virtio-blk-pci,drive=agentdata,serial=AGENT_DATA_DISK','-drive',"file=$vmDir/seed.iso,media=cdrom,readonly=on",'-nic','user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:8080-:8080,hostfwd=tcp:127.0.0.1:2222-:22','-display','none','-monitor','none','-serial','stdio')
  & $qemu @qemuArgs
  if ($LASTEXITCODE -ne 0) { throw "QEMU exited with $LASTEXITCODE" }
} finally { $lock.Dispose() }
