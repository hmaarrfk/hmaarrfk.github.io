---
title: Matlab R2016a on Linux

---

Matlab R2016a on Linux seems to have some trouble. The issue is reported [here](https://www.mathworks.com/matlabcentral/newsreader/view_thread/345009). 

It seems to have something to do with opening new windows.

```matlab
inputdlg()
```

For reference, I run Matlab in [Fedora](https://getfedora.org/) 23 x64 bit, with an Intel(R) Core(TM) i5-3570K processor and no other graphics card.

# OpenGL rendering
The issue seems to be associated with [OpenGL rendering](http://askubuntu.com/questions/765455/how-to-run-matlab-2016a-with-nvidia-drivers-of-gtx-960-in-ubuntu-16-04/767231). You can try to see if enabling software rendering helps you. In a terminal, run the following command:

```bash
/usr/local/MATLAB/R2016a/bin/matlab -softwareopengl
```

Now try to run 

```matlab
inputdlg()
```
or 

```matlab
plot(1:10)
```

If that fixes things, we can work to make this change more permanent.


## Permanently enabling software OpenGL

To permanently enable software OpenGL without modifying your other scripts, we will create a new Matlab script in the R2016a directory instead of modifying our other launchers. This has the advantage that when 2016b comes out, our hack will probably be obsolete and removed automatically.

I assume you are running all commands as root. You can change to root with the `sudo -i` command.

To do this, move the old Matlab launcher

```bash
cd /usr/local/MATLAB/R2016a/bin
mv matlab matlab_actual
```
Now create a new file called `matlab` with the following content

```bash
#!/bin/sh

/usr/local/MATLAB/R2016a/bin/matlab_actual -softwareopengl "$@"
```

Make sure `"$@"` and not just `$@` as explained [here](http://stackoverflow.com/questions/4824590/propagate-all-arguments-in-a-bash-shell-script).

Now make sure the new file is executable
```bash
chmod 755 matlab
```

Done!

# Installing matlab in system directories
If you haven't done so, you can install Matlab in a system directory so that you can launch it by just typing `matlab`. To do so run the following command

```bash
sudo ln -s /usr/local/MATLAB/R2016a/bin/matlab /usr/local/bin/.
```


# Getting rid of specific notifications

Matlab probably doesn't want you to do this, but getting a notification that you have an academic license, or any type of license every time is a little annoying.

You can remove the notification by modifying the file `/usr/local/MATLAB/R2016a/reseources/MATLAB/en/branding.xml`. Of course, you should change `en` to the language you are using for Matlab.

Within the file, find the entries 

  * `ACADEMIC_CMD_WINDOW_STR` -- make this one empty
  * `ACADEMIC_IDE_TITLE` -- make this one `MATLAB {0}`
  * `ACADEMIC_SIMULINK_MODEL_TITLE` -- make this one `{0} - Simulink`

I would keep the other entries as is. They aren't as intrusive. Of course, if you have an other type of license, you can change the appropriate string.
