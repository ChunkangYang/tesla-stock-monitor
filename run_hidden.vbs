Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = "C:\Users\cky19\Documents\workspace\playground\tesla-stock-monitor"
objShell.Run "node.exe monitor.js", 0, True
