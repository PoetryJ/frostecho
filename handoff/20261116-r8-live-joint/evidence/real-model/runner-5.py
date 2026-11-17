import pathlib,subprocess,sys
p=subprocess.run([sys.executable,"-u","research/decision-choice/jev05/action/joint_live_probe.py","--request","request.json","--head","head.safetensors","--placement","one-layer-offload","--out","run-5/result.json"])
pathlib.Path("exit-code-5.txt").write_text(str(p.returncode)+"\n")
raise SystemExit(p.returncode)
