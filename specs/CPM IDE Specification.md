# CPM IDE Specification

The CP/M IDE is a VS Code extension which assists in the development of CP/M applications on devices connected over serial line.

## Main features

1. Integrated serial terminal
2. Transparent file transfer using DIR and XMODEM commands hidden from user
3. Z80 assembler syntax colouring
4. Support for Z80 assembkler and C code building to .COM files


### Serial terminal
A VS code panel is used to provide a serial terminal with configurable baud rate etc
The terminal has a special feature which is that the extension can run commands hidden from the user in orde to provide a way to manage file transfers to and from the device.
The extension can requets the terminal run a command with the user being shown the interaction.

For this to work the extenion must monitor the termnal to see when a command promtp is avaialble such as A> so it does not try and execute command while an application is running.

The termnal has a native XModem sen/recieve implementation

The goal of this is to provide a sidebar which show the remote CP/M drive and files.

### Transparent file transfer using DIR and XMODEM commands hidden from user
At initial connection to the CP/M device the extension scans for drives by issuing A:, B: etc and checking the responses.
These commands are hidden from the user
For each valid drive a DIR is issued and a sidebar created showing the contents
If XMODEM.COM is not on a drive it is installed

The user can then fetch a file from the remote device by clicking a transfer icon next to the file name.
This transparently executes an XMODEM command and recieves the file

Files can also be sent by selecting a local file and the transfer icon

### Z80 assembler syntax colouring
Language support for Z80 assembler is included


### Support for Z80 assembkler and C code building to .COM files
A local assembler and/or compiler can be configured for builds

