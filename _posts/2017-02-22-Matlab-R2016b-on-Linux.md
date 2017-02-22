---
title: Matlab R2016b on Linux

---

I think I finally found a fix to maximizing plots in matlab and having the datatip follow your cursor correctly.

I think a related problem has been documented on the [Matlab Central](https://www.mathworks.com/matlabcentral/answers/178241-why-are-all-the-warning-boxes-blank)

If I recall correctly, I had tried to fix this a long time ago as well, but now it seems to have worked.
I'm working on an updated system using Fedora 25 (64bit).

# Requirements

You need to install `wmname`

```bash
sudo dnf install wmname
````

# The fix
Now you should change the window manager name to `LG3D`. Before executing matlab, run 

```
wmname LG3D
matlab
```

This [bugreport](https://bugzilla.redhat.com/show_bug.cgi?id=918055) helped me solve the issue.

# Permanently setting wmname

For some reason, you can't just add `wmname LG3D` to `.bashrc`. Maybe the
window manager needs to be enabled first. Instead, I created a shadow matlab
script that sets the command everytime.

I assume you are running all commands as root. You can change to root with the `sudo -i` command.

To do this, move the old Matlab launcher

```bash
cd /usr/local/MATLAB/R2016b/bin
mv matlab matlab_actual
```
Now create a new file called `matlab` with the following content

```bash
#!/bin/sh

wmname LG3D

/usr/local/MATLAB/R2016a/bin/matlab_actual "$@"
```

Make sure `"$@"` and not just `$@` as explained [here](http://stackoverflow.com/questions/4824590/propagate-all-arguments-in-a-bash-shell-script).

Now make sure the new file is executable

```bash
chmod +x matlab
```

Done!

# Installing matlab in system directories
If you haven't done so, you can install Matlab in a system directory so that you can launch it by just typing `matlab`. To do so run the following command

```bash
sudo ln -s /usr/local/MATLAB/R2016b/bin/matlab /usr/local/bin/.
```

# Fedora launchers

I also made a few fedora launchers that came be obtained through the [Copr
repository](https://copr.fedorainfracloud.org/coprs/hmaarrfk/useful_launchers/).
It has different launchers for each version of Matlab in case you have
concurrent installs.
