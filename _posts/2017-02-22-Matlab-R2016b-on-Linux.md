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

# Hardware OpenGL

It seems that Matlab bundles an old version of `libstdc++` that confilcts with
that of a modern linux install. The conflicting versions cause matlab to crash
when using hardware acceleration for OpenGL. You might get the following error message:

```
Error using gca

While setting the 'Parent' property of 'Axes':

Can't load
  '/usr/local/MATLAB/R2016a/bin/glnxa64/libmwosgserver.so':
  /usr/local/MATLAB/R2016a/bin/glnxa64/../../sys/os/glnxa64/libstdc++.so.6:
  version 'CXXABI_1.3.8' not found (required by /lib64/libGLU.so.1)
```

[This](http://stackoverflow.com/questions/38473597/matlab-on-linux-cant-plot-anythingcant-load-libstdc-so-6-version-cxxabi-1)
post explains the issue and suggests that one exports the variable `LD_PRELOAD`
before launching matlab.

```
export LD_PRELOAD=/usr/lib64/libstdc++.so.6
matlab
```


# Permanently enabling these settings

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

export LD_PRELOAD=/usr/lib64/libstdc++.so.6

/usr/local/MATLAB/R2016a/bin/matlab_actual "$@"
```

Now make sure the new file is executable

```bash
chmod +x matlab
```

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
