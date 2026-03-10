@echo off
cd strings
node index.js build languages.loc --folder "%USERPROFILE%\Documents\GitHub\MinecraftConsoles\Minecraft.Client\Windows64Media\loc"
cd ..
echo Check folder for stuff