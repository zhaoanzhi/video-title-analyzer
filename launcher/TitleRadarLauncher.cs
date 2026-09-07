using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class TitleRadarLauncher
{
    [STAThread]
    private static void Main()
    {
        const string projectDirectory = @"C:\Users\zwz\Documents\Codex\2026-09-06\video-title-analyzer\work\site";
        string batchFile = Path.Combine(projectDirectory, "启动标题雷达.bat");

        if (!File.Exists(batchFile))
        {
            MessageBox.Show(
                "没有找到启动文件：\n" + batchFile,
                "标题雷达",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = batchFile,
                WorkingDirectory = projectDirectory,
                UseShellExecute = true
            });
        }
        catch (Exception exception)
        {
            MessageBox.Show(
                "启动失败：" + exception.Message,
                "标题雷达",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }
}
