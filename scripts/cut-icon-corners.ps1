param(
  [Parameter(Mandatory=$true)][string]$Src,
  [Parameter(Mandatory=$true)][string]$Dst,
  [byte]$Tol = 245
)

Add-Type -AssemblyName System.Drawing

$code = @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class IconCornerCutter {
    public static void Cut(string src, string dst, byte tol) {
        using (var srcImg = new Bitmap(src))
        using (var img = new Bitmap(srcImg.Width, srcImg.Height, PixelFormat.Format32bppArgb)) {
            using (var g = Graphics.FromImage(img)) {
                g.DrawImage(srcImg, 0, 0, srcImg.Width, srcImg.Height);
            }
            int w = img.Width, h = img.Height;
            var rect = new Rectangle(0, 0, w, h);
            var bd = img.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
            int stride = bd.Stride;
            var px = new byte[stride * h];
            Marshal.Copy(bd.Scan0, px, 0, px.Length);

            var visited = new bool[w * h];
            var stack = new Stack<int>();
            stack.Push(0);
            stack.Push(w - 1);
            stack.Push((h - 1) * w);
            stack.Push(h * w - 1);

            while (stack.Count > 0) {
                int i = stack.Pop();
                if (i < 0 || i >= w * h || visited[i]) continue;
                visited[i] = true;
                int x = i % w, y = i / w;
                int o = y * stride + x * 4;
                byte b = px[o], g = px[o + 1], r = px[o + 2];
                bool nearWhite = r >= tol && g >= tol && b >= tol;
                if (!nearWhite) continue;
                px[o + 3] = 0;
                if (x > 0) stack.Push(i - 1);
                if (x < w - 1) stack.Push(i + 1);
                if (y > 0) stack.Push(i - w);
                if (y < h - 1) stack.Push(i + w);
            }

            Marshal.Copy(px, 0, bd.Scan0, px.Length);
            img.UnlockBits(bd);
            img.Save(dst, ImageFormat.Png);
        }
    }
}
"@

Add-Type -TypeDefinition $code -ReferencedAssemblies @('System.Drawing','System.Core')
[IconCornerCutter]::Cut($Src, $Dst, $Tol)
if (Test-Path $Dst) { Write-Output "Saved: $Dst" } else { Write-Error "Failed to save $Dst" }
