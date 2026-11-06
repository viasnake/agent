param([Parameter(Mandatory=$true)][string]$VmHome, [Parameter(Mandatory=$true)][string]$SshPublicKey)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$vmDir = [IO.Path]::GetFullPath($VmHome)
if (Test-Path $vmDir) { throw 'VM home already exists; refusing to overwrite' }
$key = (Get-Content -Raw -LiteralPath $SshPublicKey).Trim()
if ($key -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+( [^\r\n]+)?$') { throw 'Specify one OpenSSH public key' }
$qemu = (Get-Command qemu-system-x86_64.exe).Source
$qemuImg = (Get-Command qemu-img.exe).Source
$asset = (Get-Content -Raw "$PSScriptRoot/assets.json" | ConvertFrom-Json).ubuntu
New-Item -ItemType Directory -Path $vmDir | Out-Null
Invoke-WebRequest -Uri $asset.url -OutFile "$vmDir/base.img"
if ((Get-FileHash "$vmDir/base.img" -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.sha256) { throw 'Cloud image SHA-256 mismatch' }
& $qemuImg convert -O qcow2 "$vmDir/base.img" "$vmDir/os.qcow2"
if ($LASTEXITCODE -ne 0) { throw 'Image conversion failed' }
& $qemuImg resize "$vmDir/os.qcow2" 32G
if ($LASTEXITCODE -ne 0) { throw 'OS resize failed' }
& $qemuImg create -f qcow2 "$vmDir/data.qcow2" 64G
if ($LASTEXITCODE -ne 0) { throw 'Data disk creation failed' }
$seed = New-Item -ItemType Directory -Path "$vmDir/seed"
$utf8 = [Text.UTF8Encoding]::new($false)
$content = [IO.File]::ReadAllText("$PSScriptRoot/cloud-init.yaml").Replace('__SSH_KEY__', ($key | ConvertTo-Json -Compress)).Replace('__DISK_SCRIPT__', [Convert]::ToBase64String([IO.File]::ReadAllBytes("$PSScriptRoot/guest-disk.py")))
[IO.File]::WriteAllText("$seed/user-data", $content, $utf8)
[IO.File]::WriteAllText("$seed/meta-data", "instance-id: agent-$([Guid]::NewGuid())`nlocal-hostname: personal-agent`n", $utf8)
# IMAPI2FS ships with Windows; no WSL, Linux command, or background process is required.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class AgentIsoWriter {
  public static void Write(object source, string path) {
    IStream stream = (IStream)source;
    IntPtr count = Marshal.AllocHGlobal(4);
    try {
      using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write)) {
        byte[] buffer = new byte[65536]; long total = 0;
        while (true) {
          stream.Read(buffer, buffer.Length, count);
          int read = Marshal.ReadInt32(count);
          if (read == 0) break;
          total += read;
          if (total > 67108864) throw new IOException("Seed ISO exceeds limit");
          output.Write(buffer, 0, read);
        }
        output.Flush(true);
      }
    } finally { Marshal.FreeHGlobal(count); }
  }
}
'@
$image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$image.FileSystemsToCreate = 3
$image.VolumeName = 'cidata'
$image.Root.AddTree($seed.FullName, $false)
$result = $image.CreateResultImage()
[AgentIsoWriter]::Write($result.ImageStream, "$vmDir/seed.iso")
$version = (& $qemu --version) -join "`n"
[IO.File]::WriteAllText("$vmDir/qemu-version.txt", $version, $utf8)
$binaryRecord = @{ source = 'Administrator-installed QEMU from PATH'; systemSha256 = (Get-FileHash $qemu -Algorithm SHA256).Hash; imageSha256 = (Get-FileHash $qemuImg -Algorithm SHA256).Hash }
[IO.File]::WriteAllText("$vmDir/qemu-binaries.json", ($binaryRecord | ConvertTo-Json), $utf8)
Write-Output "Prepared $vmDir. Start manually with vm/start.ps1."
