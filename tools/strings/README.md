# Minecraft: Legacy Console Edition String Table Compiler

This tool can compile .xml language files from Legacy Console Edition asset folders into a new languages.loc file and a strings.h file.

Example usage:

```
npm i
node index.js build languages.loc --folder "../../MinecraftConsoles/Minecraft.Client/Windows64Media/loc"
```

This will generate a `strings.h` and `languages.loc` file based on the data in those folders.

### License
The contents of index.js are AI generated and cannot be copyrighted. Use them however you wish, I literally do not care what you do with it. However, the code does work.