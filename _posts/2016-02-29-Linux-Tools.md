---
title: Linux and Fedora Tools

---


I use [Fedora](https://getfedora.org/) as my distribution for both my desktop and laptop. Through my journey using Linux, I've become involved by submitting bugs, posting on help forums from time to time, and more recently, by packaging a few programs that I found useful.

I hope you find these useful. Let me know what you think!

## Mendeley Desktop
[Mendeley Desktop](http://mendeley.com/) is a great application meant to organize research papers. It does have an Ubuntu package, but no Fedora package.

I took the tar ball, removed the built in libraries, and pacakged it as an RPM for Fedora. You can get the packaged by adding the following [Copr Repositiory](https://copr.fedorainfracloud.org/coprs/hmaarrfk/mendeleydesktop/) to your list of repositories.

## Meep
[Meep](http://ab-initio.mit.edu/wiki/index.php/Meep) is a great electromagnetic simulator. Download it for Fedora [here](https://copr.fedorainfracloud.org/coprs/hmaarrfk/meep/). Unfortunately, I don't use it everyday and the repository might be out of date with the latest build. Email me if you want it updated for a more recent version of Fedora.

## Matlab and Comsol launchers
One can install Matlab and Comsol for Linux. Unfortunately, the recommended way of starting these programs using Linux is to start them from the command line.

I've also included an experimental 'Comsol Server+Matlab Livelink' launcher. It should be more flexible than launching the Comsol server using `comsol mphserver matlab`. At the very least, it doesn't open a second terminal window that was necessary to launch extremely old versions of Matlab.

You can install launchers for Comsol and Matlab by downloading the appropriate packages from [here](https://copr.fedorainfracloud.org/coprs/hmaarrfk/useful_launchers/).

## Nautilus Typeahead
Nautilus, the default file explorer for Gnome has undergone significant changes since the start of Gnome 3.0.

One change that has hindered my workflow is the change from typing to quickly navigate the current directory to a full fledged search starting in the current directory.
Quite often I find myself with files containing the same name for different project, such as `main.c`. I made a version of Nautilus that restores the type ahead functionality using other's patches packaged for Fedora. Find it [here](https://copr.fedorainfracloud.org/coprs/hmaarrfk/nautilus-typeahead/).
